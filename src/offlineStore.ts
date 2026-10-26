import { getFirestoreDb } from "./firebase.ts";

export type OfflineCollection = "courses" | "assignments" | "schedules" | "exams" | "studentSections";
type StoredRecord = { key: string; uid: string; collection: OfflineCollection; id: string; data: Record<string, unknown> };
type PendingWrite = StoredRecord & { deleted: boolean; queuedAt: number; token: string };
export type LocalRestoreRecord = { collection: OfflineCollection; id: string; data: Record<string, unknown> };
type StoreDatabase = IDBDatabase;

const databaseName = "campusos-local-v1";
const recordStore = "records";
const outboxStore = "outbox";
const attachmentStore = "attachments";
const watchers = new Map<string, Set<(records: Array<Record<string, unknown> & { id: string }>) => void>>();
let databasePromise: Promise<StoreDatabase> | undefined;
const flushRunning = new Set<string>();
const retryDelayMs = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const initialRetryDelayMs = 750;
const maxRetryDelayMs = 10_000;
const localChangeChannel = (() => {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return undefined;
  try { return new BroadcastChannel("campusos-local-record-changes-v1"); } catch { return undefined; }
})();

function openDatabase(): Promise<StoreDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not support local data storage."));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(recordStore)) db.createObjectStore(recordStore, { keyPath: "key" });
      if (!db.objectStoreNames.contains(outboxStore)) db.createObjectStore(outboxStore, { keyPath: "key" });
      if (!db.objectStoreNames.contains(attachmentStore)) db.createObjectStore(attachmentStore, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = undefined; reject(request.error ?? new Error("Could not open local storage.")); };
    request.onblocked = () => { databasePromise = undefined; reject(new Error("Close another CampusOS tab to finish updating local storage.")); };
  });
  return databasePromise;
}

function makeKey(uid: string, collection: OfflineCollection, id: string) { return `${uid}/${collection}/${id}`; }
function makeAttachmentKey(uid: string, id: string) { return `${uid}/attachments/${id}`; }
function watcherKey(uid: string, collection: OfflineCollection) { return `${uid}/${collection}`; }

export async function saveLocalAttachment(uid: string, id: string, file: Blob) {
  if (!uid || !id || id.includes("/") || file.size <= 0) throw new Error("This document cannot be saved.");
  const db = await openDatabase();
  const key = makeAttachmentKey(uid, id);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    tx.objectStore(attachmentStore).put({ key, uid, id, blob: file, size: file.size, type: file.type, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save the document on this device."));
    tx.onabort = () => reject(tx.error ?? new Error("Could not save the document on this device."));
  });
}

export async function getLocalAttachment(uid: string, id: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(attachmentStore, "readonly").objectStore(attachmentStore).get(makeAttachmentKey(uid, id));
    request.onsuccess = () => resolve((request.result as { blob?: Blob } | undefined)?.blob);
    request.onerror = () => reject(request.error ?? new Error("Could not open the saved document."));
  });
}

export async function deleteLocalAttachment(uid: string, id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    tx.objectStore(attachmentStore).delete(makeAttachmentKey(uid, id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function normalizeLocalValue(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") return value.toMillis();
  if (Array.isArray(value)) return value.map(normalizeLocalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeLocalValue(item)]));
  return value;
}

function readAll<T>(storeName: string): Promise<T[]> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

function refreshWatchers(uid: string, collection: OfflineCollection) {
  const key = watcherKey(uid, collection);
  const listeners = watchers.get(key);
  if (!listeners?.size) return;
  void listLocalRecords(uid, collection).then((records) => listeners.forEach((listener) => listener(records)));
}

function commit(uid: string, collection: OfflineCollection) {
  refreshWatchers(uid, collection);
  try { localChangeChannel?.postMessage({ uid, collection }); } catch { /* IndexedDB remains the source of truth if tab messaging fails. */ }
}

localChangeChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const change = event.data as { uid?: unknown; collection?: unknown } | null;
  if (!change || typeof change.uid !== "string" || typeof change.collection !== "string") return;
  if (!["courses", "assignments", "schedules", "exams", "studentSections"].includes(change.collection)) return;
  refreshWatchers(change.uid, change.collection as OfflineCollection);
});

export async function listLocalRecords(uid: string, collection: OfflineCollection): Promise<Array<Record<string, unknown> & { id: string }>> {
  return (await readAll<StoredRecord>(recordStore))
    .filter((item) => item.uid === uid && item.collection === collection)
    .map(({ id, data }) => ({ ...data, id }));
}

export function watchLocalRecords(uid: string, collection: OfflineCollection, listener: (records: Array<Record<string, unknown> & { id: string }>) => void) {
  const key = watcherKey(uid, collection);
  const listeners = watchers.get(key) ?? new Set();
  listeners.add(listener);
  watchers.set(key, listeners);
  refreshWatchers(uid, collection);
  const refreshOnResume = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") refreshWatchers(uid, collection);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("focus", refreshOnResume);
    window.addEventListener("pageshow", refreshOnResume);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", refreshOnResume);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) watchers.delete(key);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", refreshOnResume);
      window.removeEventListener("pageshow", refreshOnResume);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshOnResume);
  };
}

export async function saveLocalRecord(uid: string, collection: OfflineCollection, id: string, data: Record<string, unknown>) {
  const db = await openDatabase();
  const key = makeKey(uid, collection, id);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    const safeData = normalizeLocalValue(data) as Record<string, unknown>;
    tx.objectStore(recordStore).put({ key, uid, collection, id, data: safeData } satisfies StoredRecord);
    tx.objectStore(outboxStore).put({ key, uid, collection, id, data: safeData, deleted: false, queuedAt: Date.now(), token: crypto.randomUUID() } satisfies PendingWrite);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  commit(uid, collection);
}

/** Apply an imported backup and enqueue its cloud writes in one IndexedDB transaction. */
export async function restoreLocalRecords(uid: string, records: LocalRestoreRecord[]) {
  if (!uid || !Array.isArray(records) || records.length > 5000) throw new Error("This backup contains too many records to restore safely.");
  const allowed: OfflineCollection[] = ["courses", "assignments", "schedules", "exams", "studentSections"];
  const seen = new Set<string>();
  const prepared = records.map(({ collection, id, data }) => {
    if (!allowed.includes(collection) || typeof id !== "string" || !id || id.length > 150 || id.includes("/")
      || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("This backup contains an invalid record.");
    const key = makeKey(uid, collection, id);
    if (seen.has(key)) throw new Error("This backup contains duplicate records.");
    seen.add(key);
    return { key, uid, collection, id, data: normalizeLocalValue(data) as Record<string, unknown> } satisfies StoredRecord;
  });
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    const now = Date.now();
    for (const record of prepared) {
      tx.objectStore(recordStore).put(record);
      tx.objectStore(outboxStore).put({ ...record, deleted: false, queuedAt: now, token: crypto.randomUUID() } satisfies PendingWrite);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not restore the backup."));
    tx.onabort = () => reject(tx.error ?? new Error("Could not restore the backup."));
  });
  for (const collection of new Set(prepared.map((record) => record.collection))) commit(uid, collection);
}

export async function deleteLocalRecord(uid: string, collection: OfflineCollection, id: string) {
  const db = await openDatabase();
  const key = makeKey(uid, collection, id);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    tx.objectStore(recordStore).delete(key);
    tx.objectStore(outboxStore).put({ key, uid, collection, id, data: {}, deleted: true, queuedAt: Date.now(), token: crypto.randomUUID() } satisfies PendingWrite);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  commit(uid, collection);
}

export async function replaceWithRemoteRecords(uid: string, collection: OfflineCollection, remote: Array<Record<string, unknown> & { id: string }>, authoritative = true) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    const store = tx.objectStore(recordStore);
    const existingRequest = store.getAll();
    const pendingRequest = tx.objectStore(outboxStore).getAll();
    let existing: StoredRecord[] | undefined;
    let pending: PendingWrite[] | undefined;
    let applied = false;
    const apply = () => {
      if (!existing || !pending || applied) return;
      applied = true;
      const scope = existing.filter((item) => item.uid === uid && item.collection === collection);
      const remoteIds = new Set(remote.map((item) => item.id));
      const pendingKeys = new Set(pending.filter((item) => item.uid === uid && item.collection === collection).map((item) => item.key));
      if (authoritative) {
        for (const item of scope) if (!remoteIds.has(item.id) && !pendingKeys.has(item.key)) store.delete(item.key);
      }
      for (const { id, ...data } of remote) {
        const key = makeKey(uid, collection, id);
        if (!pendingKeys.has(key)) store.put({ key, uid, collection, id, data: normalizeLocalValue(data) as Record<string, unknown> } satisfies StoredRecord);
      }
    };
    existingRequest.onsuccess = () => { existing = existingRequest.result as StoredRecord[]; apply(); };
    pendingRequest.onsuccess = () => { pending = pendingRequest.result as PendingWrite[]; apply(); };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  commit(uid, collection);
}

export async function pendingWriteCount(uid: string, collection?: OfflineCollection) {
  return (await readAll<PendingWrite>(outboxStore))
    .filter((item) => item.uid === uid && (!collection || item.collection === collection)).length;
}

export async function syncPendingWrites(uid: string) {
  if (!navigator.onLine) return;
  if (flushRunning.has(uid)) return;
  flushRunning.add(uid);
  let failed = false;
  let failureCode: string | undefined;
  let hasMore = false;
  try {
    const db = await getFirestoreDb();
    if (!db) throw new Error("Firestore is not available yet.");
    const { deleteDoc, doc, serverTimestamp, setDoc } = await import("firebase/firestore");
    const queue = (await readAll<PendingWrite>(outboxStore)).filter((item) => item.uid === uid).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const item of queue) {
      if (!navigator.onLine) break;
      const ref = item.collection === "studentSections"
        ? doc(db, "students", uid)
        : doc(db, "students", uid, item.collection, item.id);
      try {
        if (item.collection === "studentSections") {
          if (item.id === "studyNotes" || item.id === "gradeRecords") {
            await setDoc(ref, { progress: { [item.id]: item.data.value }, updatedAt: serverTimestamp() }, { merge: true });
          } else if (!item.deleted) {
            await setDoc(ref, { [item.id]: item.data, updatedAt: serverTimestamp() }, { merge: true });
          }
        } else if (item.deleted) await deleteDoc(ref);
        else await setDoc(ref, item.data, { merge: true });
        const database = await openDatabase();
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(outboxStore, "readwrite");
          const store = tx.objectStore(outboxStore);
          const request = store.get(item.key);
          request.onsuccess = () => {
            if ((request.result as PendingWrite | undefined)?.token === item.token) store.delete(item.key);
          };
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        failed = true;
        if (error && typeof error === "object" && "code" in error) {
          const code = (error as { code?: unknown }).code;
          if (typeof code === "string" && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(code)) failureCode = code;
        }
        break;
      }
    }
  } catch (error) {
    failed = true;
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(code)) failureCode = code;
    }
  } finally {
    flushRunning.delete(uid);
    try {
      hasMore = (await readAll<PendingWrite>(outboxStore)).some((item) => item.uid === uid);
    } catch {
      // If local storage is temporarily unavailable, keep retrying instead of dropping the flush.
      failed = true;
      hasMore = true;
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("campusos-sync", {
      detail: { uid, failed, code: failureCode },
    }));
    if ((failed || hasMore) && navigator.onLine && !retryTimers.has(uid)) {
      const baseDelay = retryDelayMs.get(uid) ?? initialRetryDelayMs;
      const delay = failed ? Math.max(100, Math.round(baseDelay * (0.8 + Math.random() * 0.2))) : 0;
      const timer = setTimeout(() => {
        retryTimers.delete(uid);
        void syncPendingWrites(uid);
      }, delay);
      retryTimers.set(uid, timer);
      if (failed) retryDelayMs.set(uid, Math.min(baseDelay * 2, maxRetryDelayMs));
    } else if (!failed && !hasMore) {
      retryDelayMs.set(uid, initialRetryDelayMs);
      const timer = retryTimers.get(uid);
      if (timer) { clearTimeout(timer); retryTimers.delete(uid); }
    }
  }
}
