import test from "node:test";
import assert from "node:assert/strict";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: IDBKeyRange });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });

const { deleteLocalAttachment, deleteLocalRecord, getLocalAttachment, listLocalRecords, mergeAcademicSessionHistory, mergeAcademicSessionSelections, nextAcademicSelectionTimestamp, pendingWriteCount, replaceWithRemoteRecords, restoreLocalRecords, saveLocalAttachment, saveLocalRecord, shouldApplyAcademicSelection, watchLocalRecords } = await import("../src/offlineStore.ts");
const { normalizeCourseRecords } = await import("../src/courseRecords.ts");

test("academic selection stamps remain newer across rapid actions and clock rollback", () => {
  assert.equal(nextAcademicSelectionTimestamp("1800000000000", 1800000000000), 1800000000001);
  assert.equal(nextAcademicSelectionTimestamp("1800000000001", 1799999999000), 1800000000002);
  assert.equal(nextAcademicSelectionTimestamp(undefined, 1800000000000), 1800000000000);
});

test("queued current-session choices cannot overwrite newer or tied server selections", () => {
  const currentRemoteStamp = 1800000000000;
  assert.equal(shouldApplyAcademicSelection({ session: "2026/2027", semester: "Second semester", updatedAt: 1700000000000, onlineAtQueue: true }, currentRemoteStamp), false);
  assert.equal(shouldApplyAcademicSelection({ session: "2025/2026", semester: "First semester", updatedAt: 1700000000000, onlineAtQueue: false }, currentRemoteStamp), false);
  assert.equal(shouldApplyAcademicSelection({ session: "2025/2026", semester: "First semester", updatedAt: currentRemoteStamp, onlineAtQueue: false }, currentRemoteStamp), false);
  assert.equal(shouldApplyAcademicSelection({ session: "2025/2026", semester: "First semester", updatedAt: currentRemoteStamp + 1, onlineAtQueue: false }, currentRemoteStamp), true);
});

test("the newest local academic selection replaces an older queued selection even if its clock stamp is lower", () => {
  const queued = { session: "2025/2026", semester: "First semester", updatedAt: 1800000000000, onlineAtQueue: false };
  const latest = { session: "2026/2027", semester: "Second semester", updatedAt: 1700000000000, onlineAtQueue: true };
  assert.deepEqual(mergeAcademicSessionSelections([queued], latest), latest);
});

test("queued current-session intent survives outbox coalescing and later profile edits", async () => {
  const uid = `academic-outbox-test-${crypto.randomUUID()}`;
  const selection = { type: "select", session: "2026/2027", semester: "Second semester", updatedAt: 1700000000000, onlineAtQueue: true };
  await saveLocalRecord(uid, "studentSections", "academic", {
    session: selection.session,
    semester: selection.semester,
    selectionUpdatedAt: String(selection.updatedAt),
    sessionHistory: JSON.stringify([{ id: "session-1", year: selection.session, semester: selection.semester, createdAt: 1 }]),
  }, selection);
  await saveLocalRecord(uid, "studentSections", "academic", {
    department: "Science",
    session: selection.session,
    semester: selection.semester,
    selectionUpdatedAt: String(selection.updatedAt),
    sessionHistory: JSON.stringify([{ id: "session-1", year: selection.session, semester: selection.semester, createdAt: 1 }]),
  });

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("campusos-local-v1", 5);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const pending = await new Promise((resolve, reject) => {
    const request = database.transaction("outbox", "readonly").objectStore("outbox").get(`${uid}/studentSections/academic`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(pending.academicSessionOperations.at(-1).onlineAtQueue, true);
  assert.equal(pending.academicSessionOperations.at(-1).session, "2026/2027");
});

test("course hydration restores missing course codes from their stable local document IDs", () => {
  const [course] = normalizeCourseRecords([
    { id: "BIO 101", name: "Biology" },
  ]);
  assert.equal(course.code, "BIO 101");
  assert.equal(course.name, "Biology");
  assert.equal(course.color, "leather");
  assert.equal(course.storageId, "BIO 101");
});

test("concurrent academic updates preserve saved periods and stable session IDs", () => {
  const existing = JSON.stringify([
    { id: "first-session", year: "2025/2026", semester: "First semester", createdAt: 1 },
    { id: "second-semester", year: "2025/2026", semester: "Second semester", createdAt: 2 },
  ]);
  const incoming = JSON.stringify([
    { id: "conflicting-id", year: "2025/2026", semester: "First semester", createdAt: 3 },
    { id: "new-session", year: "2026/2027", semester: "Extended semester", createdAt: 4 },
  ]);

  assert.deepEqual(JSON.parse(mergeAcademicSessionHistory(existing, incoming)), [
    { id: "first-session", year: "2025/2026", semester: "First semester", createdAt: 1 },
    { id: "second-semester", year: "2025/2026", semester: "Second semester", createdAt: 2 },
    { id: "new-session", year: "2026/2027", semester: "Extended semester", createdAt: 4 },
  ]);
  assert.deepEqual(JSON.parse(mergeAcademicSessionHistory(existing, existing, { type: "delete", id: "first-session" })), [
    { id: "second-semester", year: "2025/2026", semester: "Second semester", createdAt: 2 },
  ]);
  assert.deepEqual(JSON.parse(mergeAcademicSessionHistory(existing, existing, {
    type: "upsert", record: { id: "first-session", year: "2026/2027", semester: "First semester", createdAt: 5 },
  })), [
    { id: "second-semester", year: "2025/2026", semester: "Second semester", createdAt: 2 },
    { id: "first-session", year: "2026/2027", semester: "First semester", createdAt: 5 },
  ]);
});

test("offline records persist per student and edits coalesce into one queued write", async () => {
  const uid = `offline-test-${crypto.randomUUID()}`;
  await saveLocalRecord(uid, "courses", "BIO 101", { code: "BIO 101", name: "Biology", color: "blue" });
  await saveLocalRecord(uid, "courses", "BIO 101", { code: "BIO 101", name: "Biology II", color: "blue" });

  const [cachedCourse] = await listLocalRecords(uid, "courses");
  assert.equal(cachedCourse.id, "BIO 101");
  assert.equal(cachedCourse.name, "Biology II");
  assert.equal(await pendingWriteCount(uid), 1);
  assert.deepEqual(await listLocalRecords(`${uid}-other`, "courses"), []);

  const offlineUpdate = new Promise((resolve) => {
    let stop = () => {};
    stop = watchLocalRecords(uid, "courses", (records) => {
      const current = records.find((record) => record.id === "BIO 101");
      if (current?.name === "Biology III") { stop(); resolve(current.name); }
    });
  });
  await saveLocalRecord(uid, "courses", "BIO 101", { code: "BIO 101", name: "Biology III", color: "blue" });
  assert.equal(await offlineUpdate, "Biology III");

  await replaceWithRemoteRecords(uid, "courses", [
    { id: "BIO 101", code: "BIO 101", name: "Stale cloud value" },
    { id: "REMOTE 1", code: "REMOTE 1", name: "Remote course" },
  ], false);
  assert.deepEqual((await listLocalRecords(uid, "courses")).map(({ id }) => id).sort(), ["BIO 101", "REMOTE 1"]);
  assert.equal((await listLocalRecords(uid, "courses")).find(({ id }) => id === "BIO 101").name, "Biology III");
  assert.equal(await pendingWriteCount(uid), 1);

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("campusos-local-v1", 5);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("outbox", "readwrite");
    transaction.objectStore("outbox").delete(`${uid}/courses/BIO 101`);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  await replaceWithRemoteRecords(uid, "courses", [], false);
  assert.deepEqual((await listLocalRecords(uid, "courses")).map(({ id }) => id).sort(), ["BIO 101", "REMOTE 1"]);

  await deleteLocalRecord(uid, "courses", "BIO 101");
  assert.deepEqual(await listLocalRecords(uid, "courses"), [{ id: "REMOTE 1", code: "REMOTE 1", name: "Remote course" }]);
  assert.equal(await pendingWriteCount(uid), 1);
});

test("student sections, notes, and grades stay local and pending cloud data cannot overwrite them", async () => {
  const uid = `student-section-test-${crypto.randomUUID()}`;
  await saveLocalRecord(uid, "studentSections", "personal", { nationality: "Ghanaian" });
  await saveLocalRecord(uid, "studentSections", "studyNotes", { value: [{ id: "note-1", title: "Offline lecture notes" }] });
  await saveLocalRecord(uid, "studentSections", "gradeRecords", { value: [{ id: "grade-1", course: "BIO 101", credits: 3, letter: "A" }] });

  await replaceWithRemoteRecords(uid, "studentSections", [
    { id: "personal", nationality: "Old cloud value" },
    { id: "studyNotes", value: [] },
    { id: "gradeRecords", value: [] },
  ], true);

  const records = await listLocalRecords(uid, "studentSections");
  assert.equal(records.find(({ id }) => id === "personal").nationality, "Ghanaian");
  assert.equal(records.find(({ id }) => id === "studyNotes").value[0].title, "Offline lecture notes");
  assert.equal(records.find(({ id }) => id === "gradeRecords").value[0].course, "BIO 101");
  assert.equal(await pendingWriteCount(uid, "studentSections"), 3);
  assert.equal(await pendingWriteCount(uid, "courses"), 0);
});

test("backup records are restored atomically to local storage and queued for sync", async () => {
  const uid = `restore-test-${crypto.randomUUID()}`;
  await restoreLocalRecords(uid, [
    { collection: "courses", id: "BIO 101", data: { code: "BIO 101", name: "Biology" } },
    { collection: "studentSections", id: "personal", data: { nationality: "Nigerian" } },
  ]);
  assert.equal((await listLocalRecords(uid, "courses"))[0].name, "Biology");
  assert.equal((await listLocalRecords(uid, "studentSections"))[0].nationality, "Nigerian");
  assert.equal(await pendingWriteCount(uid), 2);

  await assert.rejects(restoreLocalRecords(uid, [
    { collection: "courses", id: "CHEM 1", data: { code: "CHEM 1", name: "Chemistry" } },
    { collection: "wrong", id: "invalid", data: {} },
  ]));
  assert.deepEqual((await listLocalRecords(uid, "courses")).map(({ id }) => id), ["BIO 101"]);
  assert.equal(await pendingWriteCount(uid), 2);
});

test("study attachments persist privately per student and can be removed", async () => {
  const uid = `attachment-test-${crypto.randomUUID()}`;
  const content = new Blob(["private course reading"], { type: "application/pdf" });
  await saveLocalAttachment(uid, "attachment-1", content);
  const stored = await getLocalAttachment(uid, "attachment-1");
  assert.equal(stored.type, "application/pdf");
  assert.equal(await stored.text(), "private course reading");
  assert.equal(await getLocalAttachment(`${uid}-other`, "attachment-1"), undefined);
  await deleteLocalAttachment(uid, "attachment-1");
  assert.equal(await getLocalAttachment(uid, "attachment-1"), undefined);
});
