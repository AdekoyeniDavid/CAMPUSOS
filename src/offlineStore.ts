import { firebaseAuth, getFirestoreDb } from "./firebase.ts";

export type OfflineCollection = "courses" | "assignments" | "schedules" | "exams" | "events" | "studentSections" | "studyItems";
type StoredRecord = { key: string; uid: string; collection: OfflineCollection; id: string; data: Record<string, unknown> };
export type AcademicSessionSelection = { session: string; semester: string; updatedAt: number; onlineAtQueue?: boolean };
export type AcademicSessionSyncOperation =
  | { type: "upsert"; record: Record<string, unknown>; selection?: AcademicSessionSelection }
  | { type: "delete"; id: string; selection?: AcademicSessionSelection }
  | ({ type: "select" } & AcademicSessionSelection);
export type StudyRecordSyncOperation = { changes: Array<{ id: string; data?: unknown; deleted: boolean }> };
type PendingWrite = StoredRecord & { deleted: boolean; queuedAt: number; token: string; academicSessionOperation?: AcademicSessionSyncOperation; academicSessionOperations?: AcademicSessionSyncOperation[]; studyRecordOperation?: StudyRecordSyncOperation };
export type LocalRestoreRecord = { collection: OfflineCollection; id: string; data: Record<string, unknown> };
export type LocalAttachmentRecord = { id: string; blob: Blob; cloudSynced: boolean; cloudUploadPending: boolean };
export type PendingCloudOperation = { id: string; operation: Record<string, unknown>; token: string; queuedAt: number };
type StoreDatabase = IDBDatabase;

const databaseName = "campusos-local-v1";
const cloudOperationsDatabaseName = "campusos-cloud-operations-v1";
const recordStore = "records";
const outboxStore = "outbox";
const attachmentStore = "attachments";
const conflictStore = "conflicts";
const cloudOperationStore = "operations";
const pendingWritesByUserAndTimeIndex = "by-user-and-queue-time";
const watchers = new Map<string, Set<(records: Array<Record<string, unknown> & { id: string }>) => void>>();
const watcherRefreshVersions = new Map<string, number>();
const remoteSnapshotWrites = new Map<string, Promise<void>>();
let databasePromise: Promise<StoreDatabase> | undefined;
let cloudOperationsDatabasePromise: Promise<StoreDatabase> | undefined;
const flushRunning = new Set<string>();
const syncScheduled = new Set<string>();
const retryDelayMs = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const initialRetryDelayMs = 750;
const maxRetryDelayMs = 10_000;
const maxConcurrentRecordWrites = 4;
const writesPerFlush = 32;
const localChangeChannel = (() => {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return undefined;
  try { return new BroadcastChannel("campusos-local-record-changes-v1"); } catch { return undefined; }
})();

/**
 * Produce a strictly increasing selection stamp even when two taps happen in
 * the same millisecond or the device clock moves backwards. Firestore uses
 * this stamp to keep a delayed outbox write from reverting a newer selection.
 */
export function nextAcademicSelectionTimestamp(previousTimestamp: unknown, now = Date.now()) {
  const previous = typeof previousTimestamp === "number" && Number.isFinite(previousTimestamp)
    ? previousTimestamp
    : typeof previousTimestamp === "string" && /^\d{1,16}$/.test(previousTimestamp)
      ? Number(previousTimestamp)
      : 0;
  return Math.max(Math.trunc(now), Math.trunc(previous) + 1);
}

export function shouldApplyAcademicSelection(selection: AcademicSessionSelection, currentTimestamp: number) {
  // navigator.onLine only reports a network interface, not that Firestore
  // accepted this queued transaction. Always compare against the latest
  // server stamp so an old write whose acknowledgment was lost cannot revert
  // a newer selection from another signed-in device when it retries.
  // Strict ordering also makes same-millisecond actions from two devices
  // deterministic: the transaction that has already advanced the server stamp
  // wins, rather than a different selection with a tied client timestamp.
  return selection.updatedAt > currentTimestamp;
}

export function mergeAcademicSessionSelections(queued: AcademicSessionSelection[], next?: AcademicSessionSelection) {
  // This outbox belongs to one device. Its write order is the reliable order
  // of that device's user actions; comparing wall clocks here can discard the
  // latest tap when a prior selection has a future-dated stamp.
  const candidates = [...queued, ...(next ? [next] : [])];
  return candidates[candidates.length - 1];
}

function openDatabase(): Promise<StoreDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not support local data storage."));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    // The currently deployed app uses database version 5. Opening an existing
    // version-5 database at version 3 raises VersionError and prevents local
    // saves. Keep the deployed version and add any missing store without
    // deleting or replacing existing user records.
    const request = indexedDB.open(databaseName, 5);
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
      if (!db.objectStoreNames.contains(conflictStore)) db.createObjectStore(conflictStore, { keyPath: "key" });
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
  const allowed: OfflineCollection[] = ["courses", "assignments", "schedules", "exams", "events", "studentSections", "studyItems"];
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
  if (!watchers.get(key)?.size) return;
  const version = (watcherRefreshVersions.get(key) ?? 0) + 1;
  watcherRefreshVersions.set(key, version);
  void listLocalRecords(uid, collection).then((records) => {
    // IndexedDB requests can resolve out of order under load. Deliver only the
    // newest read so a slower stale academic snapshot cannot roll back a view
    // after a newer server reconciliation or local save has already completed.
    if (watcherRefreshVersions.get(key) !== version) return;
    for (const listener of watchers.get(key) ?? []) listener(records);
  });
}

function commit(uid: string, collection: OfflineCollection) {
  refreshWatchers(uid, collection);
  try { localChangeChannel?.postMessage({ uid, collection }); } catch { /* IndexedDB remains the source of truth if tab messaging fails. */ }
}

localChangeChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const change = event.data as { uid?: unknown; collection?: unknown; sync?: unknown; syncOperations?: unknown } | null;
  if (!change || typeof change.uid !== "string") return;
  if (typeof change.collection === "string" && ["courses", "assignments", "schedules", "exams", "events", "studentSections", "studyItems"].includes(change.collection)) {
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

/** Read one local entry directly instead of materializing an entire collection. */
export async function getLocalRecord(uid: string, collection: OfflineCollection, id: string): Promise<(Record<string, unknown> & { id: string }) | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(recordStore, "readonly").objectStore(recordStore).get(makeKey(uid, collection, id));
    request.onsuccess = () => {
      const record = request.result as StoredRecord | undefined;
      resolve(record ? { ...record.data, id: record.id } : undefined);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read the saved record."));
  });
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
    if (!listeners.size) {
      watchers.delete(key);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", refreshOnResume);
      window.removeEventListener("pageshow", refreshOnResume);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshOnResume);
  };
}

function mergeQueuedStudyOperations(previous: StudyRecordSyncOperation | undefined, next: StudyRecordSyncOperation, legacyValue?: unknown) {
  const changes = new Map((previous?.changes ?? []).map((change) => [change.id, change]));
  // Upgrade an older pending whole-array write without losing its local adds
  // when the next client edit is converted to record-level operations.
  if (!previous && Array.isArray(legacyValue)) {
    for (const record of legacyValue) {
      const id = studyRecordIdValue(record);
      if (id) changes.set(id, { id, data: record, deleted: false });
    }
  }
  for (const change of next.changes) changes.set(change.id, change);
  return { changes: [...changes.values()] } satisfies StudyRecordSyncOperation;
}

function academicSelection(operation: AcademicSessionSyncOperation): AcademicSessionSelection | undefined {
  if (operation.type === "select") return {
    session: operation.session,
    semester: operation.semester,
    updatedAt: operation.updatedAt,
    ...(operation.onlineAtQueue === undefined ? {} : { onlineAtQueue: operation.onlineAtQueue }),
  };
  return operation.selection;
}

function mergeQueuedAcademicOperations(previous: AcademicSessionSyncOperation[], next?: AcademicSessionSyncOperation) {
  const mutations = new Map<string, AcademicSessionSyncOperation>();
  const selections: AcademicSessionSelection[] = [];
  for (const operation of [...previous, ...(next ? [next] : [])]) {
    if (operation.type === "upsert" && typeof operation.record.id === "string") mutations.set(operation.record.id, { type: "upsert", record: operation.record });
    else if (operation.type === "delete") mutations.set(operation.id, { type: "delete", id: operation.id });
    const selection = academicSelection(operation);
    if (selection) selections.push(selection);
  }
  const selected = mergeAcademicSessionSelections(selections);
  return [
    ...mutations.values(),
    ...(selected ? [{ type: "select", ...selected } satisfies AcademicSessionSyncOperation] : []),
  ];
}

export async function saveLocalRecord(
  uid: string,
  collection: OfflineCollection,
  id: string,
  data: Record<string, unknown>,
  academicSessionOperation?: AcademicSessionSyncOperation,
  studyRecordOperation?: StudyRecordSyncOperation,
) {
  const safeData = prepareLocalRecord(uid, collection, id, data);
  const db = await openDatabase();
  const key = makeKey(uid, collection, id);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([recordStore, outboxStore], "readwrite");
    tx.objectStore(recordStore).put({ key, uid, collection, id, data: safeData } satisfies StoredRecord);
    const outbox = tx.objectStore(outboxStore);
    const pendingRequest = outbox.get(key);
    pendingRequest.onsuccess = () => {
      const previous = pendingRequest.result as PendingWrite | undefined;
        const previousAcademicOperations = previous?.academicSessionOperations
          ?? (previous?.academicSessionOperation ? [previous.academicSessionOperation] : []);
        const academicSessionOperations = mergeQueuedAcademicOperations(previousAcademicOperations, academicSessionOperation);
      outbox.put({
        key, uid, collection, id, data: safeData, deleted: false, queuedAt: Date.now(), token: crypto.randomUUID(),
        ...(academicSessionOperations.length ? { academicSessionOperations } : {}),
        ...(academicSessionOperation ? { academicSessionOperation } : previous?.academicSessionOperation ? { academicSessionOperation: previous.academicSessionOperation } : {}),
        ...(studyRecordOperation ? { studyRecordOperation: mergeQueuedStudyOperations(previous?.studyRecordOperation, studyRecordOperation, previous?.data.value) } : {}),
      } satisfies PendingWrite);
    };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  commit(uid, collection);
  announceSyncProgress(uid);
  requestImmediateSync(uid);
}

/** Apply an imported backup and enqueue its cloud writes in one IndexedDB transaction. */
export async function restoreLocalRecords(uid: string, records: LocalRestoreRecord[]) {
  if (!uid || !Array.isArray(records) || records.length > 5000) throw new Error("This backup contains too many records to restore safely.");
  const allowed: OfflineCollection[] = ["courses", "assignments", "schedules", "exams", "events", "studentSections", "studyItems"];
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

/** Remove this account's cached records, attachments, and queued writes after remote account deletion. */
export async function purgeLocalUserData(uid: string) {
  if (!uid || uid.includes("/")) throw new Error("This account identifier is invalid.");
  const [recordsDb, operationsDb] = await Promise.all([openDatabase(), openCloudOperationsDatabase()]);
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      const tx = recordsDb.transaction([recordStore, outboxStore, attachmentStore], "readwrite");
      for (const storeName of [recordStore, outboxStore, attachmentStore]) {
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const value = cursor.value as { uid?: string };
          if (value.uid === uid) cursor.delete();
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear this device's saved account data."));
      tx.onabort = () => reject(tx.error ?? new Error("Could not clear this device's saved account data."));
    }),
    new Promise<void>((resolve, reject) => {
      const tx = operationsDb.transaction(cloudOperationStore, "readwrite");
      const request = tx.objectStore(cloudOperationStore).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if ((cursor.value as { uid?: string }).uid === uid) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear this device's saved account updates."));
      tx.onabort = () => reject(tx.error ?? new Error("Could not clear this device's saved account updates."));
    }),
  ]);
  for (const collection of ["courses", "assignments", "schedules", "exams", "events", "studentSections", "studyItems"] as const) {
    for (const listener of watchers.get(watcherKey(uid, collection)) ?? []) listener([]);
    watchers.delete(watcherKey(uid, collection));
  }
  flushRunning.delete(uid);
  syncScheduled.delete(uid);
  retryDelayMs.delete(uid);
  const timer = retryTimers.get(uid);
  if (timer) clearTimeout(timer);
  retryTimers.delete(uid);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem("campusos-remembered-email");
      window.localStorage.removeItem("campusos-remember-me");
      window.localStorage.removeItem("campusos-pending-email-verification");
      window.localStorage.removeItem(`campusos-timetable-reminder-sync:${uid}`);
    } catch { /* Local preferences are best-effort after remote deletion succeeds. */ }
  }
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

function academicSessionHistory(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"
      && typeof item.id === "string" && typeof item.year === "string"
      && /^\d{4}\/\d{4}$/.test(item.year) && typeof item.semester === "string"));
  } catch {
    return [];
  }
}

function studyRecordIdValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).id === "string"
    ? (value as Record<string, unknown>).id as string
    : undefined;
}

function mergeRemoteStudySnapshotWithPending(
  remoteData: Record<string, unknown>,
  localData: Record<string, unknown> | undefined,
  pending: PendingWrite,
) {
  const remoteValue = Array.isArray(remoteData.value) ? remoteData.value : [];
  const localValue = Array.isArray(localData?.value) ? localData.value : [];
  const tombstones = remoteData.deletedStudyRecords && typeof remoteData.deletedStudyRecords === "object" && !Array.isArray(remoteData.deletedStudyRecords)
    ? remoteData.deletedStudyRecords as Record<string, unknown>
    : {};
  const operation = pending.studyRecordOperation ?? {
    changes: (Array.isArray(pending.data.value) ? pending.data.value : []).flatMap((record) => {
      const id = studyRecordIdValue(record);
      return id ? [{ id, data: record, deleted: false }] : [];
    }),
  };
  const changes = new Map(operation.changes.map((change) => [change.id, change]));
  const recordsById = new Map<string, unknown>();
  const legacyRecords: unknown[] = [];
  const legacyKeys = new Set<string>();
  const addLegacy = (record: unknown) => {
    const key = JSON.stringify(record);
    if (!legacyKeys.has(key)) { legacyKeys.add(key); legacyRecords.push(record); }
  };

  for (const record of remoteValue) {
    const id = studyRecordIdValue(record);
    if (id) {
      if (!(id in tombstones) && !changes.get(id)?.deleted) recordsById.set(id, record);
    } else addLegacy(record);
  }
  // A pending edit wins only for its own ID. Other remote records are merged
  // immediately, even though the period itself still has an outbox entry.
  for (const record of localValue) {
    const id = studyRecordIdValue(record);
    if (!id) { addLegacy(record); continue; }
    if (id in tombstones || changes.get(id)?.deleted) continue;
    if (!recordsById.has(id) || changes.has(id)) recordsById.set(id, record);
  }
  for (const change of operation.changes) {
    if (change.deleted || change.id in tombstones) recordsById.delete(change.id);
    else if (!recordsById.has(change.id) && change.data !== undefined) recordsById.set(change.id, change.data);
  }
  return {
    ...remoteData,
    ...(localData?.academicSession === undefined ? {} : { academicSession: localData.academicSession }),
    ...(localData?.semester === undefined ? {} : { semester: localData.semester }),
    value: [...legacyRecords, ...recordsById.values()],
    deletedStudyRecords: tombstones,
  };
}

/** Merge session history by academic period, preserving each existing entry ID. */
export function mergeAcademicSessionHistory(existingValue: unknown, incomingValue: unknown, operation?: AcademicSessionSyncOperation) {
  const periods = new Map<string, Record<string, unknown>>();
  for (const record of [...academicSessionHistory(existingValue), ...academicSessionHistory(incomingValue)]) {
    const periodKey = `${record.year}/${record.semester}`;
    if (!periods.has(periodKey)) periods.set(periodKey, record);
  }
  if (operation?.type === "delete") {
    for (const [key, record] of periods) if (record.id === operation.id) periods.delete(key);
  } else if (operation?.type === "upsert") {
    const record = operation.record;
    if (typeof record.id === "string" && typeof record.year === "string" && typeof record.semester === "string") {
      for (const [key, saved] of periods) {
        if (saved.id === record.id || (saved.year === record.year && saved.semester === record.semester)) periods.delete(key);
      }
      periods.set(`${record.year}/${record.semester}`, record);
    }
  }
  return JSON.stringify([...periods.values()]);
}

function pendingWriteMatchesRemote(item: PendingWrite, remoteItem: Record<string, unknown> & { id: string }) {
  const remoteData = Object.fromEntries(Object.entries(remoteItem).filter(([key]) => key !== "id"));
  if (item.studyRecordOperation) {
    const remoteRecords = Array.isArray(remoteData.value) ? remoteData.value : [];
    return item.studyRecordOperation.changes.every((change) => {
      const current = remoteRecords.find((record) => studyRecordIdValue(record) === change.id);
      const tombstones = remoteData.deletedStudyRecords && typeof remoteData.deletedStudyRecords === "object"
        ? remoteData.deletedStudyRecords as Record<string, unknown>
        : {};
      return change.deleted ? current === undefined && change.id in tombstones
        : current ? remoteValueMatchesExpected(current, change.data) : change.id in tombstones;
    });
  }
  if (item.collection !== "studentSections" || item.id !== "academic") {
    return remoteValueMatchesExpected(remoteData, item.data);
  }

  const expectedHistory = item.data.sessionHistory;
  const actualHistory = remoteData.sessionHistory;
  const expectedFields = Object.fromEntries(Object.entries(item.data).filter(([key]) => !["sessionHistory", "session", "semester", "selectionUpdatedAt"].includes(key)));
  const actualFields = Object.fromEntries(Object.entries(remoteData).filter(([key]) => !["sessionHistory", "session", "semester", "selectionUpdatedAt"].includes(key)));
  if (!remoteValueMatchesExpected(actualFields, expectedFields)) return false;
  const academicOperations = item.academicSessionOperations
    ?? (item.academicSessionOperation ? [item.academicSessionOperation] : []);
  const selection = academicOperations.reduce<AcademicSessionSelection | undefined>((latest, operation) => {
    const candidate = academicSelection(operation);
    return candidate && (!latest || candidate.updatedAt >= latest.updatedAt) ? candidate : latest;
  }, undefined);
  if (selection) {
    const remoteSelectionTime = Number(remoteData.selectionUpdatedAt) || 0;
    if (remoteSelectionTime < selection.updatedAt
      || (remoteSelectionTime === selection.updatedAt && (remoteData.session !== selection.session || remoteData.semester !== selection.semester))) return false;
  }
  const actualRecords = academicSessionHistory(actualHistory);
  for (const operation of academicOperations) {
    if (operation.type === "delete" && actualRecords.some((record) => record.id === operation.id)) return false;
    if (operation.type === "upsert" && !actualRecords.some((record) => record.id === operation.record.id
      && record.year === operation.record.year && record.semester === operation.record.semester)) return false;
  }
  const actualPeriods = new Set(actualRecords.map((record) => `${record.year}/${record.semester}`));
  return academicSessionHistory(expectedHistory).every((record) => actualPeriods.has(`${record.year}/${record.semester}`));
}

export function replaceWithRemoteRecords(uid: string, collection: OfflineCollection, remote: Array<Record<string, unknown> & { id: string }>, authoritative = true) {
  // Firestore may deliver a second snapshot while IndexedDB is still applying
  // the first one. Serialize per collection so an older, slower reconciliation
  // can never overwrite a newer realtime snapshot on this device.
  const key = watcherKey(uid, collection);
  const previous = remoteSnapshotWrites.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => applyRemoteSnapshot(uid, collection, remote, authoritative));
  remoteSnapshotWrites.set(key, task);
  return task.finally(() => {
    if (remoteSnapshotWrites.get(key) === task) remoteSnapshotWrites.delete(key);
  });
}

/** Apply Firestore's incremental document changes without rescanning a whole collection. */
export function applyRemoteRecordChanges(
  uid: string,
  collection: OfflineCollection,
  changes: Array<{ type: "added" | "modified" | "removed"; record: (Record<string, unknown> & { id: string }) }>,
) {
  if (!changes.length) return Promise.resolve();
  const key = watcherKey(uid, collection);
  const previous = remoteSnapshotWrites.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([recordStore, outboxStore], "readwrite");
      const records = tx.objectStore(recordStore);
      const outbox = tx.objectStore(outboxStore);
      let changed = false;
      for (const change of changes) {
        const recordKey = makeKey(uid, collection, change.record.id);
        const pendingRequest = outbox.get(recordKey);
        pendingRequest.onsuccess = () => {
          // Local edits win until their durable outbox entry has been accepted.
          if (pendingRequest.result) return;
          if (change.type === "removed") {
            records.delete(recordKey);
            changed = true;
            return;
          }
          const { id, ...data } = change.record;
          records.put({ key: recordKey, uid, collection, id, data: normalizeLocalValue(data) as Record<string, unknown> } satisfies StoredRecord);
          changed = true;
        };
      }
      tx.oncomplete = () => {
        if (changed) commit(uid, collection);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  remoteSnapshotWrites.set(key, task);
  return task.finally(() => {
    if (remoteSnapshotWrites.get(key) === task) remoteSnapshotWrites.delete(key);
  });
}

async function applyRemoteSnapshot(uid: string, collection: OfflineCollection, remote: Array<Record<string, unknown> & { id: string }>, authoritative: boolean) {
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
    let changedCount = 0;
    const apply = () => {
      if (!existing || !pending || applied) return;
      applied = true;
      const scope = existing.filter((item) => item.uid === uid && item.collection === collection);
      const scopeByKey = new Map(scope.map((item) => [item.key, item]));
      const remoteIds = new Set(remote.map((item) => item.id));
      const scopePending = pending.filter((item) => item.uid === uid && item.collection === collection);
      const remoteById = new Map(remote.map((item) => [item.id, item]));
      const unresolved = authoritative ? scopePending.filter((item) => {
        const remoteItem = remoteById.get(item.id);
        const acknowledged = item.deleted
          ? !remoteItem
          : Boolean(remoteItem && pendingWriteMatchesRemote(item, remoteItem));
        if (acknowledged) {
          tx.objectStore(outboxStore).delete(item.key);
          reconciledCount += 1;
          return false;
        }
        return true;
      }) : scopePending;
      const pendingKeys = new Set(unresolved.map((item) => item.key));
      // Snapshot reconciliation runs for every Firestore update. Index pending
      // writes once so merging a large note/grade collection stays linear
      // instead of rescanning the outbox for each remote record.
      const unresolvedByKey = new Map(unresolved.map((item) => [item.key, item]));
      if (authoritative) {
        for (const item of scope) if (!remoteIds.has(item.id) && !pendingKeys.has(item.key)) {
          store.delete(item.key);
          changedCount += 1;
        }
      }
      for (const { id, ...data } of remote) {
        const key = makeKey(uid, collection, id);
        const normalized = normalizeLocalValue(data) as Record<string, unknown>;
        const old = scopeByKey.get(key);
        if (pendingKeys.has(key)) {
          const pendingItem = unresolvedByKey.get(key);
          const isStudyRecord = collection === "studentSections"
            && /^(studyNotes|gradeRecords)(?:__\d{4}-\d{4}(?:__(?:first-semester|second-semester|extended-semester))?)?$/.test(id);
          if (isStudyRecord && pendingItem) {
            const merged = mergeRemoteStudySnapshotWithPending(normalized, old?.data, pendingItem);
            if (!old || !remoteValueMatchesExpected(old.data, merged) || !remoteValueMatchesExpected(merged, old.data)) {
              store.put({ key, uid, collection, id, data: merged } satisfies StoredRecord);
              changedCount += 1;
            }
          }
          continue;
        }
        if (!old || !remoteValueMatchesExpected(old.data, normalized) || !remoteValueMatchesExpected(normalized, old.data)) {
          store.put({ key, uid, collection, id, data: normalized } satisfies StoredRecord);
          changedCount += 1;
        }
      }
    };
    existingRequest.onsuccess = () => { existing = existingRequest.result as StoredRecord[]; apply(); };
    pendingRequest.onsuccess = () => { pending = pendingRequest.result as PendingWrite[]; apply(); };
    tx.oncomplete = () => {
      if (reconciledCount && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("campusos-sync", { detail: { uid, progress: true, reconciled: reconciledCount } }));
      }
      if (changedCount || reconciledCount) commit(uid, collection);
      resolve();
    };
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

export async function pendingWriteCount(uid: string, collection?: OfflineCollection) {
  // The common status/retry path needs only a count. Use IndexedDB's compound
  // index so the one-second reconnect fallback does not deserialize a growing
  // queue on low-memory mobile devices.
  const writes = collection
    ? (await readAllByKeyPrefix<PendingWrite>(outboxStore, `${uid}/`)).filter((item) => item.collection === collection).length
    : await pendingWritesCountForUser(uid);
  if (collection && collection !== "studentSections") return writes;
  const [attachmentOps, cloudOperations] = await Promise.all([
    countPendingAttachmentOperations(uid),
    listPendingCloudOperations(uid),
  ]);
  return writes + attachmentOps + cloudOperations.length;
}

/** Fast indexed count for the Firestore record outbox only. */
export function pendingRecordWriteCount(uid: string) {
  return pendingWritesCountForUser(uid);
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

async function stableStudyItemDocumentId(uid: string, periodId: string, recordId: string) {
  const source = `${uid}\u0000${periodId}\u0000${recordId}`;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Stable fallback for restricted WebViews that do not expose SubtleCrypto.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index++) {
    first = Math.imul(first ^ source.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ source.charCodeAt(index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

async function writePendingItem(uid: string, item: PendingWrite, db: NonNullable<Awaited<ReturnType<typeof getFirestoreDb>>>) {
  const { deleteDoc, deleteField, doc, runTransaction, serverTimestamp, setDoc } = await import("firebase/firestore");
  const ref = item.collection === "studentSections"
    ? doc(db, "students", uid)
    : doc(db, "students", uid, item.collection, item.id);
  const isStudyRecord = item.collection === "studentSections"
    && /^(studyNotes|gradeRecords)(?:__\d{4}-\d{4}(?:__(?:first-semester|second-semester|extended-semester))?)?$/.test(item.id);
  const studyRecordOperation = item.studyRecordOperation ?? (isStudyRecord && Array.isArray(item.data.value)
    ? { changes: item.data.value.flatMap((record) => {
      const id = studyRecordIdValue(record);
      return id ? [{ id, data: record, deleted: false }] : [];
    }) }
    : undefined);
  let committedAcademic: Record<string, unknown> | undefined;
  if (item.collection === "studentSections" && item.id === "academic" && !item.deleted) {
    // Keep history and current selection in one transaction. The outbox
    // coalesces edits to the academic profile into one record; if a user adds a
    // period and selects a current period before the first write completes, a
    // selection-only setDoc would otherwise replace the queued add and publish
    // only the current fields. The latest local history is merged here with
    // server history, while the selection timestamp prevents an older offline
    // device from reverting a newer selection when it reconnects.
    committedAcademic = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.get("academic");
      const allowedAcademicFields = new Set([
        "department", "programme", "level", "session", "semester", "selectionUpdatedAt",
        "sessionHistory", "programStart", "programEnd",
      ]);
      const currentAcademic = current && typeof current === "object" && !Array.isArray(current)
        ? Object.fromEntries(Object.entries(current as Record<string, unknown>).filter(([key]) => allowedAcademicFields.has(key)))
        : {};
      const incomingSession = item.data.session;
      const incomingSemester = item.data.semester;
      const incomingSelectionTime = Number(item.data.selectionUpdatedAt) || item.queuedAt;
      const incomingAcademic = Object.fromEntries(Object.entries(item.data).filter(([key]) => !["session", "semester", "selectionUpdatedAt"].includes(key)));
      const academic: Record<string, unknown> = {
        ...currentAcademic,
        ...incomingAcademic,
      };
      const academicOperations = item.academicSessionOperations
        ?? (item.academicSessionOperation ? [item.academicSessionOperation] : []);
      let sessionHistory = mergeAcademicSessionHistory(currentAcademic["sessionHistory"], item.data["sessionHistory"]);
      for (const operation of academicOperations) {
        if (operation.type === "delete" || operation.type === "upsert") {
          sessionHistory = mergeAcademicSessionHistory(sessionHistory, undefined, operation);
        }
      }
      academic["sessionHistory"] = sessionHistory;
      const selection = academicOperations.reduce<AcademicSessionSelection | undefined>((latest, operation) => {
        const candidate = academicSelection(operation);
        return candidate && (!latest || candidate.updatedAt >= latest.updatedAt) ? candidate : latest;
      }, undefined);
      const currentSelectionTime = Number(currentAcademic["selectionUpdatedAt"]) || 0;
      if (selection && shouldApplyAcademicSelection(selection, currentSelectionTime)) {
        academic["session"] = selection.session;
        academic["semester"] = selection.semester;
        // Keep the server-side stamp increasing even if this device's clock
        // is behind another signed-in device's clock.
        academic["selectionUpdatedAt"] = String(Math.max(selection.updatedAt, currentSelectionTime + 1));
      } else if (typeof currentAcademic["session"] !== "string" && typeof incomingSession === "string") {
        academic["session"] = incomingSession;
        academic["semester"] = incomingSemester;
        academic["selectionUpdatedAt"] = String(incomingSelectionTime);
      }
      transaction.set(ref, { academic, updatedAt: serverTimestamp() }, { merge: true });
      return academic;
    });
  } else if (isStudyRecord && studyRecordOperation && !item.deleted) {
    const scopedStudyPeriod = /^(studyNotes|gradeRecords)__(\d{4}-\d{4})__(first-semester|second-semester|extended-semester)$/.exec(item.id);
    const scopedStudyYear = /^(studyNotes|gradeRecords)__(\d{4}-\d{4})$/.exec(item.id);
    const legacyStudyRecord = item.id === "studyNotes" || item.id === "gradeRecords";
    const session = scopedStudyPeriod?.[2]?.replace("-", "/") ?? scopedStudyYear?.[2]?.replace("-", "/") ?? "Not provided";
    const semester = scopedStudyPeriod
      ? ({ "first-semester": "First semester", "second-semester": "Second semester", "extended-semester": "Extended semester" } as const)[scopedStudyPeriod[3]]
      : "Not provided";
    if (!scopedStudyPeriod && !scopedStudyYear && !legacyStudyRecord) throw new Error("This study record has an unsupported academic period.");

    // Notes and grades used to be arrays nested in the large student profile
    // document. Give each record its own stable document so a write does not
    // read/rewrite the whole profile and concurrent devices can edit separate
    // records without contending on that parent document. Old profile arrays
    // remain readable and are overlaid with these per-record updates.
    const { doc: studyDoc, writeBatch: makeBatch } = await import("firebase/firestore");
    for (let offset = 0; offset < studyRecordOperation.changes.length; offset += 400) {
      const changes = studyRecordOperation.changes.slice(offset, offset + 400);
      const batch = makeBatch(db);
      for (const change of changes) {
        const cloudId = await stableStudyItemDocumentId(uid, item.id, change.id);
        const itemRef = studyDoc(db, "students", uid, "studyItems", cloudId);
        batch.set(itemRef, {
          recordType: item.id.startsWith("gradeRecords") ? "gradeRecords" : "studyNotes",
          recordId: change.id,
          academicSession: session,
          semester,
          deleted: change.deleted,
          ...(!change.deleted && change.data !== undefined ? { record: change.data } : {}),
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
      if (changes.length) await batch.commit();
    }
  } else if (item.collection === "studentSections") {
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
  let materializedAcademic = false;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(committedAcademic ? [recordStore, outboxStore] : [outboxStore], "readwrite");
    const store = tx.objectStore(outboxStore);
    const request = store.get(item.key);
    request.onsuccess = () => {
      if ((request.result as PendingWrite | undefined)?.token === item.token) {
        store.delete(item.key);
        if (committedAcademic) {
          tx.objectStore(recordStore).put({
            key: makeKey(uid, "studentSections", "academic"),
            uid,
            collection: "studentSections",
            id: "academic",
            data: normalizeLocalValue(committedAcademic) as Record<string, unknown>,
          } satisfies StoredRecord);
          materializedAcademic = true;
        }
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  // A server snapshot can arrive before this IndexedDB acknowledgment. If the
  // listener saw the still-pending key it correctly kept the local value; now
  // apply the transaction's final server-resolved value and notify every view.
  if (materializedAcademic) commit(uid, "studentSections");
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

export async function syncPendingWrites(uid: string) {
  if (!uid || !navigator.onLine) return;
  const lockManager = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!lockManager) {
    await runPendingWriteSync(uid);
    return;
  }
  try {
    // Queue behind the current account writer rather than polling for its lock.
    // Web Locks wakes this request as soon as that flush releases the lock,
    // avoiding an artificial 300 ms handoff delay between open tabs.
    await lockManager.request(`campusos-firestore-sync:${uid}`, { mode: "exclusive" }, () => runPendingWriteSync(uid));
  } catch {
    // Web Locks are an optimization for browsers that support them. Fall back
    // to idempotent Firestore writes plus token-checked outbox acknowledgments.
    await runPendingWriteSync(uid);
  }
}

async function runPendingWriteSync(uid: string) {
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
    const academicWrites = queue.filter((item) => item.collection === "studentSections" && item.id === "academic");
    const prioritizedQueue = queue.filter((item) => !(item.collection === "studentSections" && item.id === "academic"))
      .sort((left, right) => right.queuedAt - left.queuedAt)
      .slice(0, writesPerFlush);
    const pendingSections = prioritizedQueue.filter((item) => item.collection === "studentSections");
    const isStudyRecord = (item: PendingWrite) => item.collection === "studentSections"
      && /^(studyNotes|gradeRecords)(?:__\d{4}-\d{4}(?:__(?:first-semester|second-semester|extended-semester))?)?$/.test(item.id);
    const studyWrites = pendingSections.filter(isStudyRecord).sort((left, right) => right.queuedAt - left.queuedAt);
    const sectionWrites = pendingSections.filter((item) => !isStudyRecord(item)).sort((left, right) => right.queuedAt - left.queuedAt);
    // New edits should not wait behind a large historical backlog. Each key
    // has one coalesced pending value, so newest-first is safe; deletes remain
    // idempotent and the academic selection is still committed first above.
    const recordWrites = prioritizedQueue.filter((item) => item.collection !== "studentSections");
    const recordBatches = makeRecordWriteBatches(recordWrites);
    // Commit the current-period selection before dependent academic records.
    // This keeps a newly selected session and a course/assignment created for
    // it in the same order across devices, even when the outbox has a backlog.
    for (const item of academicWrites) {
      if (!navigator.onLine) break;
      try { await writePendingItem(uid, item, db); }
      catch (error) {
        failed = true;
        if (!failureCode && error && typeof error === "object" && "code" in error) {
          const code = (error as { code?: unknown }).code;
          if (typeof code === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(code)) failureCode = code.split("/").pop();
        }
      }
    }
    let nextRecordBatch = 0;
    const recordWorker = async () => {
      while (navigator.onLine) {
        const index = nextRecordBatch++;
        if (index >= recordBatches.length) return;
        const batch = recordBatches[index];
        try { await writePendingRecordBatch(batch, db); }
        catch {
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
      // Student details share one Firestore document. Sending all queued fields
      // as one update means a single stale/invalid field can reject unrelated
      // edits (and leave every field queued). Send each section independently,
      // just like study records, so valid account changes continue syncing and
      // only the field Firestore rejects remains pending for retry.
      for (const item of sectionWrites) {
        if (!navigator.onLine) break;
        try { await writePendingItem(uid, item, db); }
        catch (error) {
          failed = true;
          if (!failureCode && error && typeof error === "object" && "code" in error) {
            const code = (error as { code?: unknown }).code;
            if (typeof code === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(code)) failureCode = code.split("/").pop();
          }
        }
      }
    };
    // Study-period records are stored under independent Firestore documents.
    // Drain those concurrently within the device/network budget so one larger
    // note batch cannot hold up grades (or another period) on a fast desktop,
    // while low-memory/mobile or metered connections remain single-file.
    let nextStudyWrite = 0;
    const studyWorker = async () => {
      while (navigator.onLine) {
        const index = nextStudyWrite++;
        if (index >= studyWrites.length) return;
        try { await writePendingItem(uid, studyWrites[index], db); }
        catch (error) {
          failed = true;
          if (!failureCode && error && typeof error === "object" && "code" in error) {
            const code = (error as { code?: unknown }).code;
            if (typeof code === "string" && /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(code)) failureCode = code.split("/").pop();
          }
        }
      }
    };
    await Promise.all([
      ...Array.from({ length: Math.min(syncConcurrencyForDevice(), recordBatches.length) }, () => recordWorker()),
      ...Array.from({ length: Math.min(syncConcurrencyForDevice(), studyWrites.length) }, () => studyWorker()),
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
      const hasUnprocessedQueue = hasMore && !failed;
      const delay = hasUnprocessedQueue ? 0 : failed ? Math.max(100, Math.round(baseDelay * (0.8 + Math.random() * 0.2))) : 0;
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
