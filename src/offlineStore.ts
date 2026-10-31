import { firebaseAuth, getFirestoreDb } from "./firebase.ts";

export type OfflineCollection = "courses" | "assignments" | "schedules" | "exams" | "events" | "studentSections";
type StoredRecord = { key: string; uid: string; collection: OfflineCollection; id: string; data: Record<string, unknown> };
type PendingWrite = StoredRecord & { deleted: boolean; queuedAt: number; token: string };
export type LocalRestoreRecord = { collection: OfflineCollection; id: string; data: Record<string, unknown> };
export type LocalAttachmentRecord = { id: string; blob: Blob; cloudSynced: boolean; cloudUploadPending: boolean };
export type PendingCloudOperation = { id: string; operation: Record<string, unknown>; token: string; queuedAt: number };
type StoreDatabase = IDBDatabase;

const databaseName = "campusos-local-v1";
const cloudOperationsDatabaseName = "campusos-cloud-operations-v1";
const recordStore = "records";
const outboxStore = "outbox";
const attachmentStore = "attachments";
const cloudOperationStore = "operations";
const pendingWritesByUserAndTimeIndex = "by-user-and-queue-time";
const watchers = new Map<string, Set<(records: Array<Record<string, unknown> & { id: string }>) => void>>();
let databasePromise: Promise<StoreDatabase> | undefined;
let cloudOperationsDatabasePromise: Promise<StoreDatabase> | undefined;
const flushRunning = new Set<string>();
const syncScheduled = new Set<string>();
const retryDelayMs = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const initialRetryDelayMs = 750;
const maxRetryDelayMs = 10_000;
const maxConcurrentRecordWrites = 4;
const localChangeChannel = (() => {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return undefined;
  try { return new BroadcastChannel("campusos-local-record-changes-v1"); } catch { return undefined; }
})();

function openDatabase(): Promise<StoreDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not support local data storage."));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(recordStore)) db.createObjectStore(recordStore, { keyPath: "key" });
      const outbox = db.objectStoreNames.contains(outboxStore)
        ? request.transaction!.objectStore(outboxStore)
        : db.createObjectStore(outboxStore, { keyPath: "key" });
      if (!outbox.indexNames.contains(pendingWritesByUserAndTimeIndex)) {
        outbox.createIndex(pendingWritesByUserAndTimeIndex, ["uid", "queuedAt"]);
      }
      if (!db.objectStoreNames.contains(attachmentStore)) db.createObjectStore(attachmentStore, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = undefined; reject(request.error ?? new Error("Could not open local storage.")); };
    request.onblocked = () => { databasePromise = undefined; reject(new Error("Close another CampusOS tab to finish updating local storage.")); };
  });
  return databasePromise;
}

function openCloudOperationsDatabase(): Promise<StoreDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not support local data storage."));
  if (cloudOperationsDatabasePromise) return cloudOperationsDatabasePromise;
  cloudOperationsDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(cloudOperationsDatabaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(cloudOperationStore)) request.result.createObjectStore(cloudOperationStore, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { cloudOperationsDatabasePromise = undefined; reject(request.error ?? new Error("Could not open the cloud update queue.")); };
    request.onblocked = () => { cloudOperationsDatabasePromise = undefined; reject(new Error("Close another CampusOS tab to finish updating the cloud update queue.")); };
  });
  return cloudOperationsDatabasePromise;
}

function makeKey(uid: string, collection: OfflineCollection, id: string) { return `${uid}/${collection}/${id}`; }
function makeAttachmentKey(uid: string, id: string) { return `${uid}/attachments/${id}`; }
function makeCloudOperationKey(uid: string, id: string) { return `${uid}/cloud-operations/${id}`; }
function watcherKey(uid: string, collection: OfflineCollection) { return `${uid}/${collection}`; }

function syncDeviceProfile() {
  if (typeof navigator === "undefined") return { network: undefined, cores: 4, memory: 4, coarsePointer: false };
  const deviceNavigator = navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean; rtt?: number };
    deviceMemory?: number;
  };
  const cores = navigator.hardwareConcurrency || 4;
  const coarsePointer = typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);
  // Safari and some WebViews omit deviceMemory. Use pointer and core hints as
  // a conservative fallback so mobile/tablet tabs do not launch desktop-sized
  // write bursts when their network API is also unavailable.
  const memory = deviceNavigator.deviceMemory ?? (coarsePointer || cores <= 4 ? 4 : 8);
  return { network: deviceNavigator.connection, cores, memory, coarsePointer };
}

function syncConcurrencyForDevice() {
  const { network, cores, memory, coarsePointer } = syncDeviceProfile();
  if (typeof navigator === "undefined") return 1;
  const connectionType = network?.effectiveType ?? "";
  if (network?.saveData || cores <= 2 || memory <= 2 || connectionType === "slow-2g" || connectionType === "2g") return 1;
  if (cores <= 4 || memory <= 4 || coarsePointer || connectionType === "3g" || (network?.rtt ?? 0) > 500) return 2;
  return maxConcurrentRecordWrites;
}

function syncBatchLimits() {
  const { network, cores, memory, coarsePointer } = syncDeviceProfile();
  if (typeof navigator === "undefined") return { operations: 20, bytes: 512 * 1024 };
  const connectionType = network?.effectiveType ?? "";
  if (network?.saveData || cores <= 2 || memory <= 2 || connectionType === "slow-2g" || connectionType === "2g" || (network?.rtt ?? 0) > 900) {
    return { operations: 8, bytes: 256 * 1024 };
  }
  if (cores <= 4 || memory <= 4 || coarsePointer || connectionType === "3g" || (network?.rtt ?? 0) > 500) {
    return { operations: 24, bytes: 1024 * 1024 };
  }
  return { operations: 100, bytes: 8 * 1024 * 1024 };
}

function requestImmediateSync(uid: string, broadcast = true) {
  if (!uid) return;
  if (broadcast) {
    try { localChangeChannel?.postMessage({ uid, sync: true }); } catch { /* The local retry path remains active if tab messaging fails. */ }
  }
  if ((typeof navigator !== "undefined" && !navigator.onLine) || syncScheduled.has(uid)) return;
  syncScheduled.add(uid);
  queueMicrotask(() => {
    syncScheduled.delete(uid);
    void syncPendingWrites(uid);
  });
}

function announceSyncProgress(uid: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid, progress: true } }));
}

export async function saveLocalAttachment(uid: string, id: string, file: Blob) {
  if (!uid || uid.includes("/") || !id || id.length > 150 || id.includes("/") || file.size <= 0 || file.size > 20 * 1024 * 1024) {
    throw new Error("This document is invalid or larger than the 20 MB limit.");
  }
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

export async function listLocalAttachments(uid: string): Promise<LocalAttachmentRecord[]> {
  return (await readAllByKeyPrefix<{ key: string; uid: string; id: string; blob?: Blob; cloudSynced?: boolean; cloudUploadPending?: boolean }>(attachmentStore, `${uid}/attachments/`))
    .filter((item) => item.blob instanceof Blob)
    .map((item) => ({ id: item.id, blob: item.blob!, cloudSynced: item.cloudSynced === true, cloudUploadPending: item.cloudUploadPending === true }));
}

export async function queueLocalAttachmentUpload(uid: string, id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    const store = tx.objectStore(attachmentStore);
    const key = makeAttachmentKey(uid, id);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, cloudUploadPending: true });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid, syncAttachments: true } }));
}

/** Clear an upload marker when no saved material refers to that local file. */
export async function clearUnreferencedAttachmentUpload(uid: string, id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    const store = tx.objectStore(attachmentStore);
    const key = makeAttachmentKey(uid, id);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result?.cloudUploadPending) store.put({ ...request.result, cloudUploadPending: false });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  announceSyncProgress(uid);
}

export async function markLocalAttachmentCloudSynced(uid: string, id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    const store = tx.objectStore(attachmentStore);
    const key = makeAttachmentKey(uid, id);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, cloudSynced: true, cloudUploadPending: false });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid } }));
}

export async function deleteLocalAttachment(uid: string, id: string, queueCloudDelete = false) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    const store = tx.objectStore(attachmentStore);
    const key = makeAttachmentKey(uid, id);
    const request = store.get(key);
    request.onsuccess = () => {
      const stored = request.result as { cloudSynced?: boolean } | undefined;
      if (queueCloudDelete && (!stored || stored.cloudSynced)) store.put({ key, uid, id, cloudDeletePending: true });
      else store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  if (typeof window !== "undefined" && queueCloudDelete) window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid, syncAttachments: true } }));
}

export async function listPendingAttachmentDeletes(uid: string): Promise<string[]> {
  return (await readAllByKeyPrefix<{ uid: string; id: string; cloudDeletePending?: boolean }>(attachmentStore, `${uid}/attachments/`))
    .filter((item) => item.cloudDeletePending === true)
    .map((item) => item.id);
}

export async function clearPendingAttachmentDelete(uid: string, id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(attachmentStore, "readwrite");
    tx.objectStore(attachmentStore).delete(makeAttachmentKey(uid, id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid } }));
}

/** Persist non-Firestore operations (for example D1 reminder mutations) in the same durable local outbox. */
export async function queuePendingCloudOperation(uid: string, id: string, operation: Record<string, unknown>) {
  if (!uid || uid.length > 128 || uid.includes("/") || !/^[A-Za-z0-9_-]{1,180}$/.test(id)
    || !operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("This cloud update is invalid and could not be queued.");
  }
  const serialized = JSON.stringify(operation);
  if (new TextEncoder().encode(serialized).byteLength > 16_000) throw new Error("This cloud update is too large to queue safely.");
  const token = crypto.randomUUID();
  const queuedAt = Date.now();
  const db = await openCloudOperationsDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(cloudOperationStore, "readwrite");
    tx.objectStore(cloudOperationStore).put({
      key: makeCloudOperationKey(uid, id), uid, id, operation: JSON.parse(serialized),
      cloudOperationPending: true, cloudOperationToken: token, cloudOperationQueuedAt: queuedAt,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not queue this cloud update on this device."));
    tx.onabort = () => reject(tx.error ?? new Error("Could not queue this cloud update on this device."));
  });
  announceSyncProgress(uid);
  try { localChangeChannel?.postMessage({ uid, syncOperations: true }); } catch { /* The retrying tab can still drain the durable outbox. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid, syncOperations: true } }));
  return { id, operation: JSON.parse(serialized) as Record<string, unknown>, token, queuedAt } satisfies PendingCloudOperation;
}

export async function listPendingCloudOperations(uid: string): Promise<PendingCloudOperation[]> {
  return (await readAllCloudOperationsByKeyPrefix<{ key: string; uid: string; id: string; operation?: Record<string, unknown>; cloudOperationPending?: boolean; cloudOperationToken?: string; cloudOperationQueuedAt?: number }>(cloudOperationStore, `${uid}/cloud-operations/`))
    .filter((item) => item.uid === uid && item.cloudOperationPending === true && typeof item.operation === "object" && !!item.operation && typeof item.cloudOperationToken === "string")
    .map((item) => ({ id: item.id, operation: item.operation!, token: item.cloudOperationToken!, queuedAt: item.cloudOperationQueuedAt ?? 0 }))
    .sort((left, right) => left.queuedAt - right.queuedAt);
}

export async function acknowledgePendingCloudOperation(uid: string, id: string, token: string) {
  const db = await openCloudOperationsDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(cloudOperationStore, "readwrite");
    const store = tx.objectStore(cloudOperationStore);
    const key = makeCloudOperationKey(uid, id);
    const request = store.get(key);
    request.onsuccess = () => {
      // A newer add/remove for the same reminder must survive an older in-flight request.
      if (request.result?.cloudOperationToken === token) store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  announceSyncProgress(uid);
}

function readAllCloudOperationsByKeyPrefix<T>(storeName: string, prefix: string): Promise<T[]> {
  return openCloudOperationsDatabase().then((db) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(range);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

function normalizeLocalValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("This entry contains an invalid date and could not be saved.");
    return timestamp;
  }
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    const timestamp = value.toMillis();
    if (!Number.isFinite(timestamp)) throw new Error("This entry contains an invalid date and could not be saved.");
    return timestamp;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("This entry contains an invalid number. Check the values and try again.");
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("This entry contains unsupported data and could not be saved.");
  if (value && typeof value === "object") {
    if (typeof Blob !== "undefined" && value instanceof Blob) throw new Error("Attachments must be saved separately from record details.");
    if (ancestors.has(value)) throw new Error("This entry contains circular data and could not be saved.");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => item === undefined ? null : normalizeLocalValue(item, ancestors));
      const normalized: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const safeValue = normalizeLocalValue(item, ancestors);
        if (safeValue !== undefined) normalized[key] = safeValue;
      }
      return normalized;
    } finally { ancestors.delete(value); }
  }
  return value;
}

function prepareLocalRecord(uid: string, collection: OfflineCollection, id: string, data: Record<string, unknown>) {
  const allowed: OfflineCollection[] = ["courses", "assignments", "schedules", "exams", "events", "studentSections"];
  if (!uid || uid.length > 128 || uid.includes("/") || !allowed.includes(collection)) throw new Error("This account or record type is invalid and could not be saved.");
  if (!id || id.length > 150 || id.includes("/") || id.includes("\u0000")) throw new Error("This entry has an invalid identifier and could not be saved.");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("This entry has invalid data and could not be saved.");
  const safeData = normalizeLocalValue(data) as Record<string, unknown>;
  let serialized: string;
  try { serialized = JSON.stringify(safeData); }
  catch { throw new Error("This entry could not be prepared for safe storage."); }
  if (new TextEncoder().encode(serialized).byteLength > 900_000) throw new Error("This entry is too large to sync safely. Reduce its size and try again.");
  return safeData;
}

function readAllByKeyPrefix<T>(storeName: string, prefix: string): Promise<T[]> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(range);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

function pendingWritesForUser(uid: string): Promise<PendingWrite[]> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([uid, 0], [uid, Number.MAX_SAFE_INTEGER]);
    const request = db.transaction(outboxStore, "readonly").objectStore(outboxStore)
      .index(pendingWritesByUserAndTimeIndex).getAll(range);
    request.onsuccess = () => resolve(request.result as PendingWrite[]);
    request.onerror = () => reject(request.error);
  }));
}

function pendingWritesCountForUser(uid: string): Promise<number> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([uid, 0], [uid, Number.MAX_SAFE_INTEGER]);
    const request = db.transaction(outboxStore, "readonly").objectStore(outboxStore)
      .index(pendingWritesByUserAndTimeIndex).count(range);
    request.onsuccess = () => resolve(request.result);
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
  const change = event.data as { uid?: unknown; collection?: unknown; sync?: unknown; syncOperations?: unknown } | null;
  if (!change || typeof change.uid !== "string") return;
  if (typeof change.collection === "string" && ["courses", "assignments", "schedules", "exams", "events", "studentSections"].includes(change.collection)) {
    refreshWatchers(change.uid, change.collection as OfflineCollection);
  }
  // Another tab may have created the queue entry while this tab was active or
  // about to be suspended. Only the same signed-in account may drain that queue.
  if (change.sync === true && firebaseAuth?.currentUser?.uid === change.uid) requestImmediateSync(change.uid, false);
  if (change.syncOperations === true && firebaseAuth?.currentUser?.uid === change.uid && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid: change.uid, syncOperations: true } }));
  }
});

export async function listLocalRecords(uid: string, collection: OfflineCollection): Promise<Array<Record<string, unknown> & { id: string }>> {
  return (await readAllByKeyPrefix<StoredRecord>(recordStore, `${uid}/${collection}/`))
    .map(({ id, data }) => ({ ...data, id }));
}

/** Return local queue keys so cloud migrations can leave unsynced edits untouched. */
export async function pendingWriteKeys(uid: string) {
  return new Set((await readAllByKeyPrefix<PendingWrite>(outboxStore, `${uid}/`))
    .map((item) => `${item.collection}/${item.id}`));
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
  const safeData = prepareLocalRecord(uid, collection, id, data);
  const db = await openDatabase();
  const key = makeKey(uid, collection, id);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    tx.objectStore(recordStore).put({ key, uid, collection, id, data: safeData } satisfies StoredRecord);
    tx.objectStore(outboxStore).put({ key, uid, collection, id, data: safeData, deleted: false, queuedAt: Date.now(), token: crypto.randomUUID() } satisfies PendingWrite);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  commit(uid, collection);
  announceSyncProgress(uid);
  requestImmediateSync(uid);
}

/** Apply an imported backup and enqueue its cloud writes in one IndexedDB transaction. */
export async function restoreLocalRecords(uid: string, records: LocalRestoreRecord[]) {
  if (!uid || !Array.isArray(records) || records.length > 5000) throw new Error("This backup contains too many records to restore safely.");
  const allowed: OfflineCollection[] = ["courses", "assignments", "schedules", "exams", "events", "studentSections"];
  const seen = new Set<string>();
  const prepared = records.map(({ collection, id, data }) => {
    if (!allowed.includes(collection) || typeof id !== "string" || !id || id.length > 150 || id.includes("/")
      || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("This backup contains an invalid record.");
    const key = makeKey(uid, collection, id);
    if (seen.has(key)) throw new Error("This backup contains duplicate records.");
    seen.add(key);
    return { key, uid, collection, id, data: prepareLocalRecord(uid, collection, id, data) } satisfies StoredRecord;
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
  announceSyncProgress(uid);
  requestImmediateSync(uid);
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
  announceSyncProgress(uid);
  requestImmediateSync(uid);
}

function remoteValueMatchesExpected(remoteValue: unknown, expectedValue: unknown): boolean {
  const remote = normalizeLocalValue(remoteValue);
  const expected = normalizeLocalValue(expectedValue);
  if (Array.isArray(expected)) {
    return Array.isArray(remote) && remote.length === expected.length
      && expected.every((item, index) => remoteValueMatchesExpected(remote[index], item));
  }
  if (expected && typeof expected === "object") {
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) return false;
    return Object.entries(expected).every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(remote, key)
      && remoteValueMatchesExpected((remote as Record<string, unknown>)[key], value));
  }
  return Object.is(remote, expected);
}

export async function replaceWithRemoteRecords(uid: string, collection: OfflineCollection, remote: Array<Record<string, unknown> & { id: string }>, authoritative = true) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    const store = tx.objectStore(recordStore);
    // Scope IndexedDB reads to this user's collection. Scanning the entire
    // device database for every live snapshot made sync slow as local history grew.
    const prefix = `${uid}/${collection}/`;
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const existingRequest = store.getAll(range);
    const pendingRequest = tx.objectStore(outboxStore).getAll(range);
    let existing: StoredRecord[] | undefined;
    let pending: PendingWrite[] | undefined;
    let applied = false;
    let reconciledCount = 0;
    const apply = () => {
      if (!existing || !pending || applied) return;
      applied = true;
      const scope = existing.filter((item) => item.uid === uid && item.collection === collection);
      const remoteIds = new Set(remote.map((item) => item.id));
      const scopePending = pending.filter((item) => item.uid === uid && item.collection === collection);
      const remoteById = new Map(remote.map((item) => [item.id, item]));
      const unresolved = authoritative ? scopePending.filter((item) => {
        const remoteItem = remoteById.get(item.id);
        const acknowledged = item.deleted
          ? !remoteItem
          : Boolean(remoteItem && remoteValueMatchesExpected(
            Object.fromEntries(Object.entries(remoteItem).filter(([key]) => key !== "id")),
            item.data,
          ));
        if (acknowledged) {
          tx.objectStore(outboxStore).delete(item.key);
          reconciledCount += 1;
          return false;
        }
        return true;
      }) : scopePending;
      const pendingKeys = new Set(unresolved.map((item) => item.key));
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
    tx.oncomplete = () => {
      if (reconciledCount && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid, progress: true, reconciled: reconciledCount } }));
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  commit(uid, collection);
}

export async function pendingWriteCount(uid: string, collection?: OfflineCollection) {
  const writes = (await readAllByKeyPrefix<PendingWrite>(outboxStore, `${uid}/`))
    .filter((item) => !collection || item.collection === collection).length;
  if (collection && collection !== "studentSections") return writes;
  const [attachmentOps, cloudOperations] = await Promise.all([
    countPendingAttachmentOperations(uid),
    listPendingCloudOperations(uid),
  ]);
  return writes + attachmentOps + cloudOperations.length;
}

/** Count upload/delete markers with a cursor so status refreshes never materialize saved PDFs. */
function countPendingAttachmentOperations(uid: string): Promise<number> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(`${uid}/attachments/`, `${uid}/attachments/\uffff`);
    const request = db.transaction(attachmentStore, "readonly").objectStore(attachmentStore).openCursor(range);
    let count = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(count); return; }
      const item = cursor.value as { cloudUploadPending?: boolean; cloudDeletePending?: boolean };
      if (item.cloudUploadPending || item.cloudDeletePending) count += 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read pending document sync status."));
  }));
}

async function writePendingItem(uid: string, item: PendingWrite, db: NonNullable<Awaited<ReturnType<typeof getFirestoreDb>>>) {
  const { deleteDoc, deleteField, doc, serverTimestamp, setDoc } = await import("firebase/firestore");
  const ref = item.collection === "studentSections"
    ? doc(db, "students", uid)
    : doc(db, "students", uid, item.collection, item.id);
  if (item.collection === "studentSections") {
    const scopedStudyPeriod = /^(studyNotes|gradeRecords)__(\d{4}-\d{4})__(first-semester|second-semester|extended-semester)$/.exec(item.id);
    const scopedStudyYear = /^(studyNotes|gradeRecords)__(\d{4}-\d{4})$/.exec(item.id);
    if (item.deleted && (item.id === "studyNotes" || item.id === "gradeRecords")) {
      await setDoc(ref, { progress: { [item.id]: deleteField() }, updatedAt: serverTimestamp() }, { merge: true });
    } else if (scopedStudyPeriod && item.deleted) {
      await setDoc(ref, { progress: { academicSessions: { [scopedStudyPeriod[2]]: { [scopedStudyPeriod[3]]: { [scopedStudyPeriod[1]]: deleteField() } } } }, updatedAt: serverTimestamp() }, { merge: true });
    } else if (scopedStudyPeriod) {
      await setDoc(ref, { progress: { academicSessions: { [scopedStudyPeriod[2]]: { [scopedStudyPeriod[3]]: { [scopedStudyPeriod[1]]: item.data.value } } } }, updatedAt: serverTimestamp() }, { merge: true });
    } else if (scopedStudyYear && item.deleted) {
      await setDoc(ref, { progress: { academicSessions: { [scopedStudyYear[2]]: { [scopedStudyYear[1]]: deleteField() } } }, updatedAt: serverTimestamp() }, { merge: true });
    } else if (scopedStudyYear) {
      await setDoc(ref, { progress: { academicSessions: { [scopedStudyYear[2]]: { [scopedStudyYear[1]]: item.data.value } } }, updatedAt: serverTimestamp() }, { merge: true });
    } else if (item.id === "studyNotes" || item.id === "gradeRecords") {
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  announceSyncProgress(uid);
}

async function acknowledgePendingWrites(items: PendingWrite[]) {
  if (!items.length) return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(outboxStore, "readwrite");
    const store = tx.objectStore(outboxStore);
    for (const item of items) {
      const request = store.get(item.key);
      request.onsuccess = () => {
        // Never clear a newer edit that replaced this queue item while the
        // Firestore batch was in flight.
        if ((request.result as PendingWrite | undefined)?.token === item.token) store.delete(item.key);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  announceSyncProgress(items[0].uid);
}

function makeRecordWriteBatches(items: PendingWrite[]) {
  const { operations: maxOperations, bytes: maxBytes } = syncBatchLimits();
  const batches: PendingWrite[][] = [];
  let batch: PendingWrite[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = new TextEncoder().encode(JSON.stringify(item.data)).byteLength;
    if (batch.length && (batch.length >= maxOperations || bytes + itemBytes > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function writePendingRecordBatch(items: PendingWrite[], db: NonNullable<Awaited<ReturnType<typeof getFirestoreDb>>>) {
  // Most interactive edits are a single record. Preserve the direct Firestore
  // write path for those, and reserve atomic batches for queued backlogs.
  if (items.length === 1) {
    await writePendingItem(items[0].uid, items[0], db);
    return;
  }
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  for (const item of items) {
    const ref = doc(db, "students", item.uid, item.collection, item.id);
    if (item.deleted) batch.delete(ref);
    else batch.set(ref, item.data, { merge: true });
  }
  await batch.commit();
  await acknowledgePendingWrites(items);
}

function mergeAtPath(target: Record<string, unknown>, path: string[], value: unknown) {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    const current = node[segment];
    if (!current || typeof current !== "object" || Array.isArray(current) || Object.getPrototypeOf(current) !== Object.prototype) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  const leaf = path.at(-1)!;
  const existing = node[leaf];
  if (value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const destination = existing && typeof existing === "object" && !Array.isArray(existing) && Object.getPrototypeOf(existing) === Object.prototype
      ? existing as Record<string, unknown>
      : {};
    for (const [key, child] of Object.entries(value)) mergeAtPath(destination, [key], child);
    node[leaf] = destination;
  } else node[leaf] = value;
}

/** Send queued fields for the shared student document together, preserving merge semantics. */
async function writePendingSectionBatch(
  uid: string,
  items: PendingWrite[],
  db: NonNullable<Awaited<ReturnType<typeof getFirestoreDb>>>,
) {
  if (!items.length) return;
  const { doc, serverTimestamp, setDoc, deleteField } = await import("firebase/firestore");
  const updates: Record<string, unknown> = {};
  for (const item of items) {
    const scopedStudyPeriod = /^(studyNotes|gradeRecords)__(\d{4}-\d{4})__(first-semester|second-semester|extended-semester)$/.exec(item.id);
    const scopedStudyYear = /^(studyNotes|gradeRecords)__(\d{4}-\d{4})$/.exec(item.id);
    let path: string[];
    let value: unknown;
    if (item.id === "studyNotes" || item.id === "gradeRecords") {
      path = ["progress", item.id];
      value = item.deleted ? deleteField() : item.data.value;
    } else if (scopedStudyPeriod) {
      path = ["progress", "academicSessions", scopedStudyPeriod[2], scopedStudyPeriod[3], scopedStudyPeriod[1]];
      value = item.deleted ? deleteField() : item.data.value;
    } else if (scopedStudyYear) {
      path = ["progress", "academicSessions", scopedStudyYear[2], scopedStudyYear[1]];
      value = item.deleted ? deleteField() : item.data.value;
    } else if (!item.deleted) {
      path = [item.id];
      value = item.data;
    } else {
      // Delete any student section, including sections added by newer app versions.
      // Otherwise an unsupported delete can remain queued forever.
      path = [item.id];
      value = deleteField();
    }
    mergeAtPath(updates, path, value);
  }
  if (!Object.keys(updates).length) return;
  await setDoc(doc(db, "students", uid), { ...updates, updatedAt: serverTimestamp() }, { merge: true });

  // Delete only queue entries that still match the version sent. A save made while
  // this network write was in flight keeps its newer token and is retried next.
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(outboxStore, "readwrite");
    const store = tx.objectStore(outboxStore);
    for (const item of items) {
      const request = store.get(item.key);
      request.onsuccess = () => {
        if ((request.result as PendingWrite | undefined)?.token === item.token) store.delete(item.key);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  announceSyncProgress(uid);
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
    // The compound index reads only this account's queue in oldest-first order,
    // avoiding a full key-prefix scan and an in-memory sort on every flush.
    const queue = await pendingWritesForUser(uid);
    const sectionWrites = queue.filter((item) => item.collection === "studentSections");
    const recordWrites = queue.filter((item) => item.collection !== "studentSections");
    const recordBatches = makeRecordWriteBatches(recordWrites);
    let nextRecordBatch = 0;
    const recordWorker = async () => {
      while (navigator.onLine) {
        const index = nextRecordBatch++;
        if (index >= recordBatches.length) return;
        const batch = recordBatches[index];
        try { await writePendingRecordBatch(batch, db); }
        catch (error) {
          // A rejected batch must not let one invalid record block unrelated
          // valid changes. Fall back to the existing idempotent per-record path.
          let nextItem = 0;
          const fallbackWorker = async () => {
            while (navigator.onLine) {
              const itemIndex = nextItem++;
              if (itemIndex >= batch.length) return;
              try { await writePendingItem(uid, batch[itemIndex], db); }
              catch (itemError) {
                failed = true;
                if (!failureCode && itemError && typeof itemError === "object" && "code" in itemError) {
                  const code = (itemError as { code?: unknown }).code;
                  if (typeof code === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(code)) failureCode = code.split("/").pop();
                }
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(syncConcurrencyForDevice(), batch.length) }, () => fallbackWorker()));
        }
      }
    };
    const sectionWorker = async () => {
      if (!sectionWrites.length || !navigator.onLine) return;
      try { await writePendingSectionBatch(uid, sectionWrites, db); }
      catch (error) {
        failed = true;
        if (!failureCode && error && typeof error === "object" && "code" in error) {
          const code = (error as { code?: unknown }).code;
          if (typeof code === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(code)) failureCode = code.split("/").pop();
        }
      }
    };
    await Promise.all([
      ...Array.from({ length: Math.min(syncConcurrencyForDevice(), recordBatches.length) }, () => recordWorker()),
      sectionWorker(),
    ]);
  } catch (error) {
    failed = true;
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(code)) failureCode = code.split("/").pop();
    }
  } finally {
    flushRunning.delete(uid);
    try {
      hasMore = (await pendingWritesCountForUser(uid)) > 0;
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
