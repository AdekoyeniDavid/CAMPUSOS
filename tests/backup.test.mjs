import test from "node:test";
import assert from "node:assert/strict";

const { recordsFromBackup, validateBackup } = await import("../src/backup.ts");
const { createBackupPdf } = await import("../src/backupPdf.ts");

const backup = (uid) => ({
  app: "CampusOS", version: 1, studentUid: uid, createdAt: new Date().toISOString(),
  student: { personal: { nationality: "Nigerian" }, progress: { studyNotes: [{ id: "n1" }], gradeRecords: [] } },
  collections: {
    courses: [{ id: "BIO 101", data: { code: "BIO 101", name: "Biology", color: "blue" } }],
    assignments: [{ id: "a1", data: { id: "a1", title: "Essay", question: "Write an essay", due: "2026-11-01", completed: false } }],
    schedules: [{ id: "s1", data: { courseCode: "BIO 101", day: "Monday", start: "09:00", end: "10:00" } }],
    exams: [{ id: "e1", data: { title: "Biology exam", courseCode: "BIO 101", date: "2026-11-01", start: "09:00", location: "Hall A" } }],
  },
});

test("validates account-bound backups and converts every record for atomic restore", () => {
  const data = backup("student-1");
  assert.equal(validateBackup(data, "student-1"), true);
  assert.equal(validateBackup(data, "student-2"), false);
  const records = recordsFromBackup(data);
  assert.equal(records.length, 8);
  assert.deepEqual(records.find(({ id }) => id === "progress").data, {});
  assert.deepEqual(records.find(({ id }) => id === "studyNotes").data, { value: [{ id: "n1" }] });
});

test("rejects malformed, duplicate, oversized, or privileged backup data", () => {
  const wrongPath = backup("student-1");
  wrongPath.collections.courses[0].id = "../other";
  assert.equal(validateBackup(wrongPath, "student-1"), false);

  const duplicate = backup("student-1");
  duplicate.collections.courses.push(duplicate.collections.courses[0]);
  assert.equal(validateBackup(duplicate, "student-1"), false);

  const privileged = backup("student-1");
  privileged.student.authorizedStaffUids = { value: ["attacker"] };
  assert.equal(validateBackup(privileged, "student-1"), false);

  const invalidCourse = backup("student-1");
  invalidCourse.collections.courses[0].data.name = "";
  assert.equal(validateBackup(invalidCourse, "student-1"), false);
});

test("formats a readable PDF with student sections and labeled academic records", async () => {
  const pdf = await createBackupPdf(backup("student-1")).text();
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /Account summary/);
  assert.match(pdf, /Personal details/);
  assert.match(pdf, /Assignments/);
  assert.match(pdf, /Biology exam/);
  assert.match(pdf, /Weekly timetable/);
  assert.match(pdf, /%%EOF\n$/);
});
