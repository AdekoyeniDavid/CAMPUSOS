import type { User } from "firebase/auth";
import { firebaseAuth, getFirebaseAppInstance, getFirebaseStorageBucket, getFirestoreDb } from "./firebase";
import { purgeLocalUserData } from "./offlineStore";

async function removeCloudflareData(user: User) {
  const token = await user.getIdToken(true);
  const response = await fetch("/api/account/delete", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof payload?.error === "string" ? payload.error : "Reminder data could not be removed. Retry before closing the account.");
  }
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch { /* Server-side subscription removal already prevents future delivery. */ }
  }
}

function storageErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

function isStorageNotInitialized(error: unknown) {
  return ["storage/bucket-not-found", "storage/project-not-found", "storage/no-default-bucket"].includes(storageErrorCode(error));
}

async function removeFirebaseData(user: User) {
  const db = await getFirestoreDb();
  const app = getFirebaseAppInstance();
  const bucket = getFirebaseStorageBucket();
  if (!db || !app) throw new Error("Firebase account data could not be reached. Retry while online.");

  const firestore = await import("firebase/firestore");
  const { deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch, collection } = firestore;
  const studentRef = doc(db, "students", user.uid);
  const studentSnapshot = await getDoc(studentRef);
  if (studentSnapshot.exists()) {
    // This owner-only lock stops writes from other sessions while cleanup runs.
    await setDoc(doc(db, "students", user.uid, "security", "account-deletion"), { requestedAt: serverTimestamp() });
  }

  await removeCloudflareData(user);

  if (bucket) {
    const storageModule = await import("firebase/storage");
    const storage = storageModule.getStorage(app, `gs://${bucket}`);
    const folder = storageModule.ref(storage, `students/${user.uid}/study-materials`);
    try {
      const list = await storageModule.listAll(folder);
      // The account owns this private, flat attachment folder. Delete every object,
      // including files not referenced by a surviving note.
      for (const item of list.items) {
        try { await storageModule.deleteObject(item); }
        catch (error) { if (storageErrorCode(error) !== "storage/object-not-found") throw error; }
      }
      for (const prefix of list.prefixes) {
        const nested = await storageModule.listAll(prefix);
        for (const item of nested.items) {
          try { await storageModule.deleteObject(item); }
          catch (error) { if (storageErrorCode(error) !== "storage/object-not-found") throw error; }
        }
      }
    } catch (error) {
      // Some CampusOS Firebase projects have never initialized Cloud Storage.
      // There can be no cloud objects in that case, so continue deleting the
      // account's Firestore/Auth data. Permission and network errors still stop
      // deletion rather than leaving uploaded files behind.
      if (!isStorageNotInitialized(error)) throw error;
    }
  }

  if (studentSnapshot.exists()) {
    const childCollections = ["courses", "assignments", "schedules", "exams", "events", "notificationReminders"];
    const childSnapshots = await Promise.all(childCollections.map((name) => getDocs(collection(db, "students", user.uid, name))));
    const securityRef = doc(db, "students", user.uid, "security", "session-control");
    const sessionControl = await getDoc(securityRef);
    const refs = childSnapshots.flatMap((snapshot) => snapshot.docs.map((item) => item.ref));
    if (sessionControl.exists()) refs.push(securityRef);

    for (let offset = 0; offset < refs.length; offset += 400) {
      const batch = writeBatch(db);
      for (const ref of refs.slice(offset, offset + 400)) batch.delete(ref);
      await batch.commit();
    }
    await deleteDoc(studentRef);
    // Firestore does not cascade a parent deletion. Remove the lock document
    // after its parent is gone; its rule only permits this verified owner case.
    await deleteDoc(doc(db, "students", user.uid, "security", "account-deletion"));
  }
}

export async function deleteStudentAccount(user: User) {
  if (!firebaseAuth || firebaseAuth.currentUser?.uid !== user.uid) throw new Error("Sign in again before deleting this account.");
  await removeFirebaseData(user);
  try {
    const { deleteUser } = await import("firebase/auth");
    await deleteUser(user);
  } finally {
    // Remote data is already removed. Clear this device even if Firebase Auth
    // needs another recent sign-in before it can close the identity.
    await purgeLocalUserData(user.uid);
  }
}
