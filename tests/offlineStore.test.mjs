import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";

Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });

const { deleteLocalRecord, listLocalRecords, pendingWriteCount, replaceWithRemoteRecords, saveLocalRecord } = await import("../src/offlineStore.ts");
const { normalizeCourseRecords } = await import("../src/courseRecords.ts");

test("course hydration restores missing course codes from their stable local document IDs", () => {
  assert.deepEqual(normalizeCourseRecords([
    { id: "BIO 101", name: "Biology" },
  ]), [{ code: "BIO 101", name: "Biology", color: "leather" }]);
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

  await replaceWithRemoteRecords(uid, "courses", [
    { id: "BIO 101", code: "BIO 101", name: "Stale cloud value" },
    { id: "REMOTE 1", code: "REMOTE 1", name: "Remote course" },
  ], false);
  assert.deepEqual((await listLocalRecords(uid, "courses")).map(({ id }) => id).sort(), ["BIO 101", "REMOTE 1"]);
  assert.equal((await listLocalRecords(uid, "courses")).find(({ id }) => id === "BIO 101").name, "Biology II");
  assert.equal(await pendingWriteCount(uid), 1);

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("campusos-local-v1", 1);
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
