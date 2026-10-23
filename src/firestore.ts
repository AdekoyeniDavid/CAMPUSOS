import type { User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QuerySnapshot,
} from "firebase/firestore";
import { firestoreDb } from "./firebase";

export type StudentSection = "profile" | "institution" | "personal" | "contact" | "academic" | "enrolment" | "courses" | "progress";
export type CourseRecord = { code: string; name: string; color: string };
export type AssignmentRecord = { title: string; question: string; course: string; due: string; completed: boolean };
export type ScheduleRecord = { courseCode: string; day: string; start: string; end: string };
export type ExamRecord = { title: string; courseCode: string; date: string; start: string; location: string };

function requireDatabase() {
  if (!firestoreDb) throw new Error("Firebase is not configured.");
  return firestoreDb;
}

function studentRef(uid: string) {
  return doc(requireDatabase(), "students", uid);
}

function studentCollection(uid: string, name: "courses" | "assignments" | "schedules" | "exams") {
  return collection(requireDatabase(), "students", uid, name);
}

export async function ensureStudentRecord(user: User) {
  const db = requireDatabase();
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
  await setDoc(studentRef(uid), { [section]: values, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveCourse(uid: string, code: string, course: CourseRecord, isNew = true) {
  const ref = doc(requireDatabase(), "students", uid, "courses", code);
  if (isNew) {
    await setDoc(ref, { ...course, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return;
  }
  await updateDoc(ref, { ...course, updatedAt: serverTimestamp() });
}

export async function renameCourse(uid: string, oldCode: string, newCode: string, course: CourseRecord) {
  if (oldCode === newCode) return saveCourse(uid, newCode, course, false);
  const db = requireDatabase();
  const [oldCourse, assignments, schedules] = await Promise.all([
    getDoc(doc(db, "students", uid, "courses", oldCode)),
    getDocs(query(studentCollection(uid, "assignments"), where("course", "==", oldCode))),
    getDocs(query(studentCollection(uid, "schedules"), where("courseCode", "==", oldCode))),
  ]);
  const refs = [
    ...assignments.docs.map((item) => ({ ref: item.ref, data: { course: newCode } })),
    ...schedules.docs.map((item) => ({ ref: item.ref, data: { courseCode: newCode } })),
  ];
  for (let offset = 0; offset < refs.length; offset += 450) {
    const batch = writeBatch(db);
    refs.slice(offset, offset + 450).forEach(({ ref, data }) => batch.update(ref, { ...data, updatedAt: serverTimestamp() }));
    if (offset === 0) {
      batch.set(doc(db, "students", uid, "courses", newCode), { ...course, createdAt: oldCourse.data()?.createdAt ?? serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      batch.delete(doc(db, "students", uid, "courses", oldCode));
    }
    await batch.commit();
  }
  if (refs.length === 0) {
    const batch = writeBatch(db);
    batch.set(doc(db, "students", uid, "courses", newCode), { ...course, createdAt: oldCourse.data()?.createdAt ?? serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
    batch.delete(doc(db, "students", uid, "courses", oldCode));
    await batch.commit();
  }
}

export async function deleteCourse(uid: string, code: string) {
  const db = requireDatabase();
  const relatedSchedules = await getDocs(query(studentCollection(uid, "schedules"), where("courseCode", "==", code)));
  const refs = [doc(db, "students", uid, "courses", code), ...relatedSchedules.docs.map((schedule) => schedule.ref)];
  for (let offset = 0; offset < refs.length; offset += 450) {
    const batch = writeBatch(db);
    refs.slice(offset, offset + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

export async function saveAssignment(uid: string, id: string, assignment: AssignmentRecord, isNew: boolean) {
  const ref = doc(requireDatabase(), "students", uid, "assignments", id);
  if (isNew) {
    await setDoc(ref, { ...assignment, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return;
  }
  await updateDoc(ref, { ...assignment, updatedAt: serverTimestamp() });
}

export async function deleteAssignment(uid: string, id: string) {
  await deleteDoc(doc(requireDatabase(), "students", uid, "assignments", id));
}

export async function saveSchedule(uid: string, id: string, schedule: ScheduleRecord, isNew: boolean) {
  const ref = doc(requireDatabase(), "students", uid, "schedules", id);
  if (isNew) {
    await setDoc(ref, { ...schedule, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return;
  }
  await updateDoc(ref, { ...schedule, updatedAt: serverTimestamp() });
}

export async function deleteSchedule(uid: string, id: string) {
  await deleteDoc(doc(requireDatabase(), "students", uid, "schedules", id));
}

export async function saveExam(uid: string, id: string, exam: ExamRecord, isNew: boolean) {
  const ref = doc(requireDatabase(), "students", uid, "exams", id);
  if (isNew) {
    await setDoc(ref, { ...exam, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return;
  }
  await updateDoc(ref, { ...exam, updatedAt: serverTimestamp() });
}

export async function deleteExam(uid: string, id: string) {
  await deleteDoc(doc(requireDatabase(), "students", uid, "exams", id));
}

export function recordData(snapshot: QuerySnapshot<DocumentData>) {
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}
