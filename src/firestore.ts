import type { User } from "firebase/auth";
import type { DocumentData, QuerySnapshot } from "firebase/firestore";
import { getFirestoreDb } from "./firebase";
import { deleteLocalRecord, listLocalRecords, replaceWithRemoteRecords, saveLocalRecord, syncPendingWrites, type OfflineCollection } from "./offlineStore";

export type StudentSection = "profile" | "institution" | "personal" | "contact" | "academic" | "enrolment" | "courses" | "progress";
export type CourseRecord = { code: string; name: string; color: string };
export type AssignmentRecord = { title: string; question: string; course: string; due: string; completed: boolean };
export type ScheduleRecord = { courseCode: string; day: string; start: string; end: string };
export type ExamRecord = { title: string; courseCode: string; date: string; start: string; location: string };
const studentSections: StudentSection[] = ["profile", "institution", "personal", "contact", "academic", "enrolment", "courses", "progress"];

export async function ensureStudentRecord(user: User) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Firebase is not configured.");
  const { doc, getDoc, serverTimestamp, setDoc } = await import("firebase/firestore");
  const ref = doc(db, "students", user.uid);
  const existing = await getDoc(ref);
  if (existing.exists()) return;

  const displayName = user.displayName?.trim() || user.email?.split("@")[0] || "Student";
  await setDoc(ref, {
    uid: user.uid,
    email: user.email ?? "",
    profile: { fullName: displayName, studentId: "Not provided", programme: "Not provided", photo: "" },
    institution: { name: "Not provided" },
    personal: { dateOfBirth: "", gender: "Not provided", nationality: "Not provided" },
    contact: { email: user.email ?? "", phone: "", address: "" },
    academic: { department: "Not provided", programme: "Not provided", level: "Not provided", session: "Not provided" },
    enrolment: { admissionDate: "", status: "Not provided", graduation: "" },
    courses: { registeredCourses: "" },
    progress: { gpa: "Not provided", completedCredits: "Not provided", standing: "Not provided" },
    authorizedStaffUids: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function saveStudentSection(uid: string, section: StudentSection, values: Record<string, string>) {
  await saveLocalRecord(uid, "studentSections", section, values);
  if (navigator.onLine) void syncPendingWrites(uid);
}

export async function saveStudyRecord(uid: string, field: "studyNotes" | "gradeRecords", value: unknown[]) {
  await saveLocalRecord(uid, "studentSections", field, { value });
  if (navigator.onLine) void syncPendingWrites(uid);
}

export function watchStudentDocument(
  uid: string,
  listener: (student: Record<string, unknown> | undefined, fromCache: boolean) => void,
  onError: (error: unknown) => void,
) {
  let cancelled = false;
  let unsubscribe = () => {};
  void getFirestoreDb().then(async (db) => {
    if (!db) throw new Error("Firebase is not configured.");
    const { doc, onSnapshot } = await import("firebase/firestore");
    if (cancelled) return;
    unsubscribe = onSnapshot(doc(db, "students", uid), (snapshot) => {
      listener(snapshot.exists() ? snapshot.data() : undefined, snapshot.metadata.fromCache);
    }, onError);
  }).catch(onError);
  return () => { cancelled = true; unsubscribe(); };
}

export function watchStudentCollection(
  uid: string,
  collectionName: Exclude<OfflineCollection, "studentSections">,
  listener: (records: Array<Record<string, unknown> & { id: string }>, fromCache: boolean) => void,
  onError: (error: unknown) => void,
) {
  let cancelled = false;
  let unsubscribe = () => {};
  void getFirestoreDb().then(async (db) => {
    if (!db) throw new Error("Firebase is not configured.");
    const { collection, onSnapshot } = await import("firebase/firestore");
    if (cancelled) return;
    unsubscribe = onSnapshot(collection(db, "students", uid, collectionName), (snapshot) => {
      listener(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })), snapshot.metadata.fromCache);
    }, onError);
  }).catch(onError);
  return () => { cancelled = true; unsubscribe(); };
}

export function watchSessionRevocation(
  uid: string,
  authTime: number,
  onRevoked: () => void,
  onError: (error: unknown) => void,
) {
  let cancelled = false;
  let unsubscribe = () => {};
  void getFirestoreDb().then(async (db) => {
    if (!db) throw new Error("Firebase is not configured.");
    const { doc, onSnapshot } = await import("firebase/firestore");
    if (cancelled) return;
    unsubscribe = onSnapshot(doc(db, "students", uid, "security", "session-control"), (snapshot) => {
      if (!snapshot.exists()) return;
      const revokedAt = snapshot.get("revokedAt");
      const exemptAuthTime = snapshot.get("exemptAuthTime");
      if (!revokedAt || typeof revokedAt.seconds !== "number") return;
      if (authTime === exemptAuthTime || authTime >= revokedAt.seconds) return;
      onRevoked();
    }, onError);
  }).catch(onError);
  return () => { cancelled = true; unsubscribe(); };
}

export async function revokeOtherSessions(uid: string, authTime: number) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Secure session storage is unavailable.");
  const { doc, serverTimestamp, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, "students", uid, "security", "session-control"), {
    revokedAt: serverTimestamp(),
    exemptAuthTime: authTime,
  });
}

export async function cacheStudentDocument(uid: string, student: Record<string, unknown>, authoritative: boolean) {
  const records: Array<Record<string, unknown> & { id: string }> = [];
  for (const section of studentSections) {
    const value = student[section];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sectionData = { ...(value as Record<string, unknown>) };
      if (section === "progress") {
        delete sectionData.studyNotes;
        delete sectionData.gradeRecords;
      }
      records.push({ ...sectionData, id: section });
    }
  }
  const progress = student.progress;
  if (progress && typeof progress === "object") {
    const progressData = progress as Record<string, unknown>;
    for (const field of ["studyNotes", "gradeRecords"] as const) {
      if (Array.isArray(progressData[field])) records.push({ id: field, value: progressData[field] });
    }
  }
  await replaceWithRemoteRecords(uid, "studentSections", records, authoritative);
}

export async function saveCourse(uid: string, code: string, course: CourseRecord, isNew = true) {
  await saveAndQueue(uid, "courses", code, course, isNew);
}

export async function renameCourse(uid: string, oldCode: string, newCode: string, course: CourseRecord) {
  if (oldCode === newCode) return saveCourse(uid, newCode, course, false);
  const [oldCourses, assignments, schedules] = await Promise.all([
    listLocalRecords(uid, "courses"), listLocalRecords(uid, "assignments"), listLocalRecords(uid, "schedules"),
  ]);
  const previous = oldCourses.find((item) => item.id === oldCode);
  await saveAndQueue(uid, "courses", newCode, { ...course, createdAt: previous?.["createdAt"] ?? Date.now() });
  for (const assignment of assignments.filter((item) => item["course"] === oldCode)) {
    const { id, ...data } = assignment; await saveAndQueue(uid, "assignments", id, { ...data, course: newCode });
  }
  for (const schedule of schedules.filter((item) => item["courseCode"] === oldCode)) {
    const { id, ...data } = schedule; await saveAndQueue(uid, "schedules", id, { ...data, courseCode: newCode });
  }
  await deleteAndQueue(uid, "courses", oldCode);
}

export async function deleteCourse(uid: string, code: string) {
  const schedules = await listLocalRecords(uid, "schedules");
  for (const schedule of schedules.filter((item) => item["courseCode"] === code)) await deleteAndQueue(uid, "schedules", schedule.id);
  await deleteAndQueue(uid, "courses", code);
}

export async function saveAssignment(uid: string, id: string, assignment: AssignmentRecord, isNew: boolean) {
  await saveAndQueue(uid, "assignments", id, assignment, isNew);
}

export async function deleteAssignment(uid: string, id: string) {
  await deleteAndQueue(uid, "assignments", id);
}

export async function saveSchedule(uid: string, id: string, schedule: ScheduleRecord, isNew: boolean) {
  await saveAndQueue(uid, "schedules", id, schedule, isNew);
}

export async function deleteSchedule(uid: string, id: string) {
  await deleteAndQueue(uid, "schedules", id);
}

export async function saveExam(uid: string, id: string, exam: ExamRecord, isNew: boolean) {
  await saveAndQueue(uid, "exams", id, exam, isNew);
}

export async function deleteExam(uid: string, id: string) {
  await deleteAndQueue(uid, "exams", id);
}

async function saveAndQueue(uid: string, collection: OfflineCollection, id: string, data: Record<string, unknown>, isNew = false) {
  const now = Date.now();
  await saveLocalRecord(uid, collection, id, { ...data, ...(isNew && !("createdAt" in data) ? { createdAt: now } : {}), updatedAt: now });
  if (navigator.onLine) void syncPendingWrites(uid);
}

async function deleteAndQueue(uid: string, collection: OfflineCollection, id: string) {
  await deleteLocalRecord(uid, collection, id);
  if (navigator.onLine) void syncPendingWrites(uid);
}

export function recordData(snapshot: QuerySnapshot<DocumentData>) {
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}
