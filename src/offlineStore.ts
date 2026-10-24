import { getFirestoreDb } from "./firebase";

export type OfflineCollection = "courses" | "assignments" | "schedules" | "exams" | "studentSections";
type StoredRecord = { key: string; uid: string; collection: OfflineCollection; id: string; data: Record<string, unknown> };
type PendingWrite = StoredRecord & { deleted: boolean; queuedAt: number; token: string };
type StoreDatabase = IDBDatabase;

const databaseName = "campusos-local-v1";
const recordStore = "records";
const outboxStore = "outbox";
const watchers = new Map<string, Set<(records: Array<Record<string, unknown> & { id: string }>) => void>>();
let databasePromise: Promise<StoreDatabase> | undefined;
const flushRunning = new Set<string>();
const retryDelayMs = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function openDatabase(): Promise<StoreDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not support local data storage."));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(recordStore)) db.createObjectStore(recordStore, { keyPath: "key" });
      if (!db.objectStoreNames.contains(outboxStore)) db.createObjectStore(outboxStore, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = undefined; reject(request.error ?? new Error("Could not open local storage.")); };
    request.onblocked = () => { databasePromise = undefined; reject(new Error("Close another CampusOS tab to finish updating local storage.")); };
  });
  return databasePromise;
}

function makeKey(uid: string, collection: OfflineCollection, id: string) { return `${uid}/${collection}/${id}`; }
function watcherKey(uid: string, collection: OfflineCollection) { return `${uid}/${collection}`; }

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

function commit(uid: string, collection: OfflineCollection) {
  const key = watcherKey(uid, collection);
  const listeners = watchers.get(key);
  if (!listeners?.size) return;
  void listLocalRecords(uid, collection).then((records) => listeners.forEach((listener) => listener(records)));
}

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
  void listLocalRecords(uid, collection).then(listener);
  return () => { listeners.delete(listener); if (!listeners.size) watchers.delete(key); };
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
    const { deleteDoc, doc, FieldPath, serverTimestamp, setDoc, updateDoc } = await import("firebase/firestore");
    const queue = (await readAll<PendingWrite>(outboxStore)).filter((item) => item.uid === uid).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const item of queue) {
      if (!navigator.onLine) break;
      const ref = item.collection === "studentSections"
        ? doc(db, "students", uid)
        : doc(db, "students", uid, item.collection, item.id);
      try {
        if (item.collection === "studentSections") {
          if (item.id === "studyNotes" || item.id === "gradeRecords") {
            await updateDoc(ref, new FieldPath("progress", item.id), item.data.value, "updatedAt", serverTimestamp());
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
      const delay = failed ? retryDelayMs.get(uid) ?? 1_000 : 0;
      const timer = setTimeout(() => {
        retryTimers.delete(uid);
        void syncPendingWrites(uid);
      }, delay);
      retryTimers.set(uid, timer);
      if (failed) retryDelayMs.set(uid, Math.min((retryDelayMs.get(uid) ?? 1_000) * 2, 60_000));
    } else if (!failed && !hasMore) {
      retryDelayMs.set(uid, 1_000);
      const timer = retryTimers.get(uid);
      if (timer) { clearTimeout(timer); retryTimers.delete(uid); }
    }
  }
}
