import type { User } from "firebase/auth";
import type { DocumentData, QuerySnapshot } from "firebase/firestore";
import { getFirebaseAppInstance, getFirebaseStorageBucket, getFirestoreDb } from "./firebase";
import { clearPendingAttachmentDelete, clearUnreferencedAttachmentUpload, deleteLocalRecord, listLocalAttachments, listLocalRecords, listPendingAttachmentDeletes, markLocalAttachmentCloudSynced, pendingWriteKeys, queueLocalAttachmentUpload, replaceWithRemoteRecords, saveLocalRecord, type OfflineCollection } from "./offlineStore";
import { watchWithReconnect } from "./reconnect";

export type StudentSection = "profile" | "institution" | "personal" | "contact" | "academic" | "enrolment" | "courses" | "progress";
export type CourseRecord = { code: string; name: string; color: string; creditUnits?: number; lecturerName?: string; lectureVenue?: string; archived?: boolean; academicSession?: string; semester?: string; storageId?: string };
export type AssignmentRecord = { title: string; question: string; description?: string; course: string; due: string; dueDate?: string; completed: boolean; studentId?: string; academicSession?: string; semester?: string; createdAt?: number | string | { seconds?: number }; updatedAt?: number | string | { seconds?: number } };
export type ScheduleRecord = { courseCode: string; day: string; start: string; end: string; academicSession?: string; semester?: string };
export type ExamRecord = { title: string; courseCode: string; date: string; start: string; end?: string; location: string; academicSession?: string; semester?: string };
export type EventRecord = { title: string; description: string; date?: string; start?: string; end?: string; location?: string; scheduled: boolean; academicSession?: string; semester?: string };
export type TimetableReminderPreference = { sourceType: "weekly" | "exam" | "event"; sourceId: string; courseCode: string; leadMinutes: number };
export type AssignmentReminderPreference = { sourceType: "assignment"; sourceId: string; courseCode: string; dueDate: string; dueTime: string; leadMinutes: number };
const studentSections: StudentSection[] = ["profile", "institution", "personal", "contact", "academic", "enrolment", "courses", "progress"];

function validateStudyAttachmentPath(uid: string, attachmentId: string) {
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId)) throw new Error("This study document has an invalid identifier.");
  const app = getFirebaseAppInstance();
  const bucket = getFirebaseStorageBucket();
  if (!app || !bucket) throw new Error("Firebase file storage is not configured for this project.");
  return { app, bucket, path: `students/${uid}/study-materials/${attachmentId}` };
}

export async function uploadStudyAttachment(uid: string, attachmentId: string, file: Blob) {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("Documents must be smaller than 20 MB.");
  const { app, bucket, path } = validateStudyAttachmentPath(uid, attachmentId);
  const { getStorage, ref, uploadBytes } = await import("firebase/storage");
  const allowedContentTypes = new Set([
    "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text", "application/rtf", "text/rtf", "text/plain", "application/zip", "application/octet-stream",
  ]);
  const contentType = allowedContentTypes.has(file.type) ? file.type : "application/octet-stream";
  await uploadBytes(ref(getStorage(app, `gs://${bucket}`), path), file, { contentType });
}

export async function downloadStudyAttachmentFromCloud(uid: string, attachmentId: string) {
  const { app, bucket, path } = validateStudyAttachmentPath(uid, attachmentId);
  const { getStorage, getBytes, ref } = await import("firebase/storage");
  const bytes = await getBytes(ref(getStorage(app, `gs://${bucket}`), path), 20 * 1024 * 1024);
  return new Blob([bytes]);
}

export async function deleteStudyAttachmentFromCloud(uid: string, attachmentId: string) {
  const { app, bucket, path } = validateStudyAttachmentPath(uid, attachmentId);
  const { deleteObject, getStorage, ref } = await import("firebase/storage");
  await deleteObject(ref(getStorage(app, `gs://${bucket}`), path));
}

const activeStudyAttachmentSyncs = new Map<string, Promise<void>>();

/** Retry saved document uploads/deletions in the background on any signed-in page. */
export function syncPendingStudyAttachments(uid: string) {
  if (!uid || (typeof navigator !== "undefined" && !navigator.onLine)) return Promise.resolve();
  const existing = activeStudyAttachmentSyncs.get(uid);
  if (existing) return existing;
  const task = (async () => {
    const [records, attachments, pendingDeletes] = await Promise.all([
      listLocalRecords(uid, "studentSections"),
      listLocalAttachments(uid),
      listPendingAttachmentDeletes(uid),
    ]);
    for (const id of pendingDeletes) {
      try { await deleteStudyAttachmentFromCloud(uid, id); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if (code !== "storage/object-not-found") throw error;
      }
      await clearPendingAttachmentDelete(uid, id);
    }
    const referenced = new Set<string>();
    for (const record of records) {
      if (!record.id.startsWith("studyNotes") || !Array.isArray(record["value"])) continue;
      for (const note of record["value"]) {
        if (!note || typeof note !== "object" || !("attachment" in note)) continue;
        const attachment = (note as { attachment?: { id?: unknown } }).attachment;
        if (typeof attachment?.id === "string") referenced.add(attachment.id);
      }
    }
    for (const attachment of attachments) {
      if (!referenced.has(attachment.id)) {
        if (attachment.cloudUploadPending) await clearUnreferencedAttachmentUpload(uid, attachment.id);
        continue;
      }
      if (attachment.cloudSynced) continue;
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      if (!attachment.cloudUploadPending) {
        await queueLocalAttachmentUpload(uid, attachment.id);
      }
      await uploadStudyAttachment(uid, attachment.id, attachment.blob);
      await markLocalAttachmentCloudSynced(uid, attachment.id);
    }
  })();
  activeStudyAttachmentSyncs.set(uid, task);
  return task.finally(() => {
    if (activeStudyAttachmentSyncs.get(uid) === task) activeStudyAttachmentSyncs.delete(uid);
  });
}

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
    academic: { department: "Not provided", programme: "Not provided", level: "Not provided", session: "Not provided", sessionHistory: "[]" },
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
}

export function studyRecordId(field: "studyNotes" | "gradeRecords", session: string, semester?: string) {
  const yearKey = session.replace("/", "-");
  return `${field}__${yearKey}${semester ? `__${semester.toLowerCase().replace(/\s+/g, "-")}` : ""}`;
}

export async function saveStudyRecord(uid: string, field: "studyNotes" | "gradeRecords", value: unknown[], session = "Not provided", semester?: string) {
  if (!/^\d{4}\/\d{4}$/.test(session) || !["First semester", "Second semester", "Extended semester"].includes(semester ?? "")) {
    throw new Error("Set a current academic year and semester in Student Account → Academic Details before saving study records.");
  }
  const id = studyRecordId(field, session, semester);
  await saveLocalRecord(uid, "studentSections", id, { value, academicSession: session, semester });
}

const semesterOptions = ["First semester", "Second semester", "Extended semester"] as const;
const periodMigrationRuns = new Map<string, Promise<number>>();

type AcademicPeriod = { session: string; semester: typeof semesterOptions[number]; createdAt: number };

function timestampMilliseconds(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object") {
    const timestamp = value as { seconds?: unknown; toMillis?: () => number };
    if (typeof timestamp.toMillis === "function") {
      const parsed = timestamp.toMillis();
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof timestamp.seconds === "number" && Number.isFinite(timestamp.seconds)) return timestamp.seconds * 1000;
  }
  return 0;
}

function oldestSavedAcademicPeriod(academic: Record<string, unknown> | undefined): AcademicPeriod | undefined {
  if (!academic) return undefined;
  let periods: AcademicPeriod[] = [];
  try {
    const history = JSON.parse(typeof academic["sessionHistory"] === "string" ? academic["sessionHistory"] : "[]") as unknown;
    if (Array.isArray(history)) periods = history.flatMap((entry): AcademicPeriod[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const year = typeof item["year"] === "string" ? item["year"].trim() : "";
      const semester = item["semester"];
      if (!/^\d{4}\/\d{4}$/.test(year) || !semesterOptions.includes(semester as typeof semesterOptions[number])) return [];
      return [{ session: year, semester: semester as typeof semesterOptions[number], createdAt: timestampMilliseconds(item["createdAt"]) }];
    });
  } catch { /* Fall back to the saved current period for older profile documents. */ }

  if (!periods.length) {
    const session = academic["session"];
    const semester = academic["semester"];
    if (typeof session === "string" && /^\d{4}\/\d{4}$/.test(session) && semesterOptions.includes(semester as typeof semesterOptions[number])) {
      periods = [{ session, semester: semester as typeof semesterOptions[number], createdAt: 0 }];
    }
  }
  return periods.sort((a, b) => a.createdAt - b.createdAt || a.session.localeCompare(b.session, undefined, { numeric: true }) || semesterOptions.indexOf(a.semester) - semesterOptions.indexOf(b.semester))[0];
}

function mergeStudyValues(current: unknown[], legacy: unknown[]) {
  const merged = [...current];
  const seen = new Set(current.map((item) => item && typeof item === "object" && "id" in item && typeof item.id === "string" ? `id:${item.id}` : `value:${JSON.stringify(item)}`));
  for (const item of legacy) {
    const key = item && typeof item === "object" && "id" in item && typeof item.id === "string" ? `id:${item.id}` : `value:${JSON.stringify(item)}`;
    if (!seen.has(key)) { merged.push(item); seen.add(key); }
  }
  return merged;
}

/** Safely assigns pre-period records to the oldest valid academic period in the student's saved history. */
export async function migrateLegacyRecordsToOldestAcademicPeriod(uid: string): Promise<number> {
  if (!uid) return 0;
  const migrationKey = uid;
  const running = periodMigrationRuns.get(migrationKey);
  if (running) return running;

  const task = (async () => {
    const [courses, assignments, schedules, exams, events, sections, pendingKeys] = await Promise.all([
      listLocalRecords(uid, "courses"), listLocalRecords(uid, "assignments"), listLocalRecords(uid, "schedules"),
      listLocalRecords(uid, "exams"), listLocalRecords(uid, "events"), listLocalRecords(uid, "studentSections"),
      pendingWriteKeys(uid),
    ]);
    const academic = sections.find((record) => record.id === "academic");
    const destination = oldestSavedAcademicPeriod(academic);
    // Wait for the saved profile/history to load before moving legacy data. Using the current
    // selection here could misfile old records if it arrives before the session history snapshot.
    if (!destination) return 0;
    const { session, semester } = destination;
    const isUnscoped = (record: Record<string, unknown>) =>
      typeof record["academicSession"] !== "string" || !/^\d{4}\/\d{4}$/.test(record["academicSession"])
      || !semesterOptions.includes(record["semester"] as typeof semesterOptions[number]);
    // Older builds may already have placed legacy records in the session that
    // happened to be current at the time. If the record predates the user's
    // first saved academic period, rehome it to that original period too.
    const belongsToOldestPeriod = (collection: OfflineCollection, record: Record<string, unknown>) => {
      const id = typeof record["id"] === "string" ? record["id"] : "";
      if (!id || pendingKeys.has(`${collection}/${id}`)) return false;
      if (isUnscoped(record)) return true;
      if (record["academicSession"] === session && record["semester"] === semester) return false;
      const createdAt = timestampMilliseconds(record["createdAt"]);
      return destination.createdAt > 0 && createdAt > 0 && createdAt < destination.createdAt;
    };
    let migrated = 0;
    for (const record of courses) {
      if (!belongsToOldestPeriod("courses", record)) continue;
      const code = typeof record["code"] === "string" && record["code"].trim() ? record["code"].trim().toUpperCase() : record.id;
      const targetId = sessionCourseId(session, semester, code);
      const existing = courses.find((candidate) => candidate.id === targetId);
      if (existing && pendingKeys.has(`courses/${targetId}`)) continue;
      const { id: oldId, storageId: _storageId, ...sourceData } = record;
      const targetData = existing ? Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "id" && key !== "storageId")) : {};
      await saveAndQueue(uid, "courses", targetId, { ...sourceData, ...targetData, code, academicSession: session, semester });
      if (oldId !== targetId) await deleteAndQueue(uid, "courses", oldId);
      migrated += 1;
    }

    for (const [collection, records] of [["assignments", assignments], ["schedules", schedules], ["exams", exams], ["events", events]] as const) {
      for (const record of records) {
        if (!belongsToOldestPeriod(collection, record)) continue;
        const { id, ...data } = record;
        await saveAndQueue(uid, collection, id, { ...data, academicSession: session, semester });
        migrated += 1;
      }
    }

    for (const record of sections) {
      if (!belongsToOldestPeriod("studentSections", record)) continue;
      const legacyStudyId = /^(studyNotes|gradeRecords)(?:__(\d{4}-\d{4}))?$/.exec(record.id);
      if (!legacyStudyId || !Array.isArray(record["value"])) continue;
      const hasCompletePeriod = typeof record["academicSession"] === "string"
        && /^\d{4}\/\d{4}$/.test(record["academicSession"])
        && semesterOptions.includes(record["semester"] as typeof semesterOptions[number]);
      // Period-keyed legacy notes without a semester and the original unscoped note/grade
      // arrays are included. Fully period-scoped records are already in the right place.
      if (hasCompletePeriod) continue;
      const field = legacyStudyId[1] as "studyNotes" | "gradeRecords";
      const targetId = studyRecordId(field, session, semester);
      const existing = sections.find((candidate) => candidate.id === targetId);
      if (existing && pendingKeys.has(`studentSections/${targetId}`)) continue;
      const existingValue = Array.isArray(existing?.["value"]) ? existing["value"] as unknown[] : [];
      const { id: oldId, ...sourceData } = record;
      const targetValue = mergeStudyValues(existingValue, record["value"] as unknown[]);
      await saveAndQueue(uid, "studentSections", targetId, {
        ...(existing ? Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "id")) : sourceData),
        value: targetValue, academicSession: session, semester,
      });
      if (oldId !== targetId) await deleteAndQueue(uid, "studentSections", oldId);
      migrated += 1;
    }
    return migrated;
  })();
  periodMigrationRuns.set(migrationKey, task);
  try { return await task; }
  finally { if (periodMigrationRuns.get(migrationKey) === task) periodMigrationRuns.delete(migrationKey); }
}

export async function deleteLegacyStudyRecord(uid: string, field: "studyNotes" | "gradeRecords") {
  await deleteLocalRecord(uid, "studentSections", field);
}

export function watchStudentDocument(
  uid: string,
  listener: (student: Record<string, unknown> | undefined, fromCache: boolean) => void,
  onError: (error: unknown) => void,
) {
  return watchWithReconnect<[Record<string, unknown> | undefined, boolean]>(async (next, error) => {
    const db = await getFirestoreDb();
    if (!db) throw new Error("Firebase is not configured.");
    const { doc, onSnapshot } = await import("firebase/firestore");
    return onSnapshot(doc(db, "students", uid), { includeMetadataChanges: true }, (snapshot) => {
      next([snapshot.exists() ? snapshot.data() : undefined, snapshot.metadata.fromCache]);
    }, error);
  }, ([student, fromCache]) => listener(student, fromCache), onError, { isHealthy: ([, fromCache]) => !fromCache });
}

export function watchStudentCollection(
  uid: string,
  collectionName: Exclude<OfflineCollection, "studentSections">,
  listener: (records: Array<Record<string, unknown> & { id: string }>, fromCache: boolean) => void,
  onError: (error: unknown) => void,
) {
  return watchWithReconnect<[Array<Record<string, unknown> & { id: string }>, boolean]>(async (next, error) => {
    const db = await getFirestoreDb();
    if (!db) throw new Error("Firebase is not configured.");
    const { collection, onSnapshot } = await import("firebase/firestore");
    return onSnapshot(collection(db, "students", uid, collectionName), { includeMetadataChanges: true }, (snapshot) => {
      next([snapshot.docs.map((item) => ({ ...item.data(), id: item.id })), snapshot.metadata.fromCache]);
    }, error);
  }, ([records, fromCache]) => listener(records, fromCache), onError, { isHealthy: ([, fromCache]) => !fromCache });
}

export function watchTimetableReminderPreferences(
  uid: string,
  listener: (records: TimetableReminderPreference[], fromCache: boolean) => void,
  onError: (error: unknown) => void,
) {
  return watchWithReconnect<[TimetableReminderPreference[], boolean]>(async (next, error) => {
    const db = await getFirestoreDb();
    if (!db) throw new Error("Firebase is not configured.");
    const { collection, onSnapshot } = await import("firebase/firestore");
    return onSnapshot(collection(db, "students", uid, "notificationReminders"), (snapshot) => {
      const records = snapshot.docs.flatMap((item) => {
        const data = item.data();
        if (!(["weekly", "exam", "event"].includes(data.sourceType)) || typeof data.sourceId !== "string" || typeof data.courseCode !== "string" || ![5, 15, 30, 60].includes(data.leadMinutes)) return [];
        return [{ sourceType: data.sourceType, sourceId: data.sourceId, courseCode: data.courseCode, leadMinutes: data.leadMinutes } as TimetableReminderPreference];
      });
      next([records, snapshot.metadata.fromCache]);
    }, error);
  }, ([records, fromCache]) => listener(records, fromCache), onError, { isHealthy: ([, fromCache]) => !fromCache });
}

export async function saveTimetableReminderPreference(uid: string, preference: TimetableReminderPreference) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Firebase is not configured.");
  const { doc, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, "students", uid, "notificationReminders", `${preference.sourceType}_${preference.sourceId}`), preference);
}

export async function removeTimetableReminderPreference(uid: string, sourceType: "weekly" | "exam" | "event", sourceId: string) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Firebase is not configured.");
  const { deleteDoc, doc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "students", uid, "notificationReminders", `${sourceType}_${sourceId}`));
}

export async function removeCourseTimetableReminderPreferences(uid: string, courseCode: string) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Firebase is not configured.");
  const { collection, getDocs, query, where, writeBatch } = await import("firebase/firestore");
  const reminders = await getDocs(query(collection(db, "students", uid, "notificationReminders"), where("courseCode", "==", courseCode.toUpperCase())));
  if (!reminders.size) return;
  const batch = writeBatch(db);
  reminders.docs.forEach((reminder) => batch.delete(reminder.ref));
  await batch.commit();
}

export function watchAssignmentReminderPreferences(
  uid: string,
  listener: (records: AssignmentReminderPreference[], fromCache: boolean) => void,
  onError: (error: unknown) => void,
) {
  return watchWithReconnect<[AssignmentReminderPreference[], boolean]>(async (next, error) => {
    const db = await getFirestoreDb();
    if (!db) throw new Error("Firebase is not configured.");
    const { collection, onSnapshot } = await import("firebase/firestore");
    return onSnapshot(collection(db, "students", uid, "notificationReminders"), (snapshot) => {
      const records = snapshot.docs.flatMap((item) => {
        const data = item.data();
        if (data.sourceType !== "assignment" || typeof data.sourceId !== "string" || typeof data.courseCode !== "string" || typeof data.dueDate !== "string" || typeof data.dueTime !== "string" || ![5, 15, 30, 60, 1440].includes(data.leadMinutes)) return [];
        return [{ sourceType: "assignment", sourceId: data.sourceId, courseCode: data.courseCode, dueDate: data.dueDate, dueTime: data.dueTime, leadMinutes: data.leadMinutes } as AssignmentReminderPreference];
      });
      next([records, snapshot.metadata.fromCache]);
    }, error);
  }, ([records, fromCache]) => listener(records, fromCache), onError, { isHealthy: ([, fromCache]) => !fromCache });
}

export async function saveAssignmentReminderPreference(uid: string, preference: AssignmentReminderPreference) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Firebase is not configured.");
  const { doc, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, "students", uid, "notificationReminders", `assignment_${preference.sourceId}`), preference);
}

export async function removeAssignmentReminderPreference(uid: string, assignmentId: string) {
  const db = await getFirestoreDb();
  if (!db) throw new Error("Firebase is not configured.");
  const { deleteDoc, doc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "students", uid, "notificationReminders", `assignment_${assignmentId}`));
}

export function watchSessionRevocation(
  uid: string,
  authTime: number,
  onRevoked: () => void,
  onError: (error: unknown) => void,
) {
  return watchWithReconnect<void>(async (next, error) => {
    const db = await getFirestoreDb();
    if (!db) throw new Error("Firebase is not configured.");
    const { doc, onSnapshot } = await import("firebase/firestore");
    return onSnapshot(doc(db, "students", uid, "security", "session-control"), (snapshot) => {
      if (!snapshot.exists()) return;
      const revokedAt = snapshot.get("revokedAt");
      const exemptAuthTime = snapshot.get("exemptAuthTime");
      if (!revokedAt || typeof revokedAt.seconds !== "number") return;
      if (authTime === exemptAuthTime || authTime >= revokedAt.seconds) return;
      next(undefined);
    }, error);
  }, () => onRevoked(), onError);
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
    const academicSessions = progressData.academicSessions;
    if (academicSessions && typeof academicSessions === "object" && !Array.isArray(academicSessions)) {
      const semesterNames: Record<string, string> = { "first-semester": "First semester", "second-semester": "Second semester", "extended-semester": "Extended semester" };
      for (const [sessionKey, sessionValue] of Object.entries(academicSessions as Record<string, unknown>)) {
        if (!/^\d{4}-\d{4}$/.test(sessionKey) || !sessionValue || typeof sessionValue !== "object" || Array.isArray(sessionValue)) continue;
        const session = sessionKey.replace("-", "/");
        const scoped = sessionValue as Record<string, unknown>;
        for (const field of ["studyNotes", "gradeRecords"] as const) {
          if (Array.isArray(scoped[field])) records.push({ id: studyRecordId(field, session), value: scoped[field], academicSession: session });
        }
        for (const [semesterSlug, semesterValue] of Object.entries(scoped)) {
          const semester = semesterNames[semesterSlug];
          if (!semester || !semesterValue || typeof semesterValue !== "object" || Array.isArray(semesterValue)) continue;
          const semesterData = semesterValue as Record<string, unknown>;
          for (const field of ["studyNotes", "gradeRecords"] as const) {
            if (Array.isArray(semesterData[field])) records.push({ id: studyRecordId(field, session, semester), value: semesterData[field], academicSession: session, semester });
          }
        }
      }
    }
  }
  await replaceWithRemoteRecords(uid, "studentSections", records, authoritative);
}

function sessionCourseId(session: string | undefined, semester: string | undefined, code: string) {
  if (!session || !/^\d{4}\/\d{4}$/.test(session)) return code;
  const periodKey = semester ? `__${semester.toLowerCase().replace(/\s+/g, "-")}` : "";
  return `${session.replace("/", "-")}${periodKey}__${encodeURIComponent(code)}`;
}

export async function saveCourse(uid: string, code: string, course: CourseRecord, isNew = true) {
  const id = course.storageId ?? sessionCourseId(course.academicSession, course.semester, code);
  const { storageId: _storageId, ...data } = course;
  await saveAndQueue(uid, "courses", id, data, isNew);
}

export async function renameCourse(uid: string, oldCode: string, newCode: string, course: CourseRecord, oldStorageId?: string) {
  if (oldCode === newCode) return saveCourse(uid, newCode, { ...course, storageId: oldStorageId ?? course.storageId }, false);
  const [oldCourses, assignments, schedules, studentSections] = await Promise.all([
    listLocalRecords(uid, "courses"), listLocalRecords(uid, "assignments"), listLocalRecords(uid, "schedules"), listLocalRecords(uid, "studentSections"),
  ]);
  const previous = oldCourses.find((item) => item.id === (oldStorageId ?? course.storageId) || (item.id === oldCode && item["academicSession"] === course.academicSession));
  const { storageId: _storageId, ...courseData } = course;
  const newStorageId = sessionCourseId(course.academicSession, course.semester, newCode);
  await saveAndQueue(uid, "courses", newStorageId, { ...courseData, createdAt: previous?.["createdAt"] ?? Date.now() });
  const sameSession = (item: Record<string, unknown>) => item["academicSession"] === course.academicSession && item["semester"] === course.semester;
  for (const assignment of assignments.filter((item) => item["course"] === oldCode && sameSession(item))) {
    const { id, ...data } = assignment; await saveAndQueue(uid, "assignments", id, { ...data, course: newCode });
  }
  for (const schedule of schedules.filter((item) => item["courseCode"] === oldCode && sameSession(item))) {
    const { id, ...data } = schedule; await saveAndQueue(uid, "schedules", id, { ...data, courseCode: newCode });
  }
  const notesId = course.academicSession ? studyRecordId("studyNotes", course.academicSession, course.semester) : "studyNotes";
  const savedNotes = studentSections.find((item) => item.id === notesId)?.["value"];
  const normalizedOldCode = oldCode.trim().toUpperCase();
  if (Array.isArray(savedNotes)) {
    const renamedNotes = savedNotes.map((item) => item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).courseCode === "string"
      && ((item as Record<string, unknown>).courseCode as string).trim().toUpperCase() === normalizedOldCode
      ? { ...(item as Record<string, unknown>), courseCode: newCode }
      : item);
    if (renamedNotes.some((item, index) => item !== savedNotes[index])) await saveStudyRecord(uid, "studyNotes", renamedNotes, course.academicSession, course.semester);
  }
  await deleteAndQueue(uid, "courses", previous?.id ?? oldStorageId ?? oldCode);
}

export async function deleteCourse(uid: string, code: string, session?: string, storageId?: string, semester?: string) {
  const [schedules, exams] = await Promise.all([
    listLocalRecords(uid, "schedules"), listLocalRecords(uid, "exams"),
  ]);
  const matchesCourse = (item: Record<string, unknown>) => typeof item["courseCode"] === "string" && item["courseCode"].trim().toUpperCase() === code.trim().toUpperCase() && (!session || item["academicSession"] === session) && (!semester || item["semester"] === semester);
  for (const schedule of schedules.filter(matchesCourse)) await deleteAndQueue(uid, "schedules", schedule.id);
  for (const exam of exams.filter(matchesCourse)) await deleteAndQueue(uid, "exams", exam.id);
  const courseRecords = await listLocalRecords(uid, "courses");
  const target = courseRecords.find((item) => item.id === storageId) ?? courseRecords.find((item) => item["code"] === code && item["academicSession"] === session && item["semester"] === semester) ?? courseRecords.find((item) => item.id === code);
  if (target) await deleteAndQueue(uid, "courses", target.id);
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

export async function saveEvent(uid: string, id: string, event: EventRecord, isNew: boolean) {
  await saveAndQueue(uid, "events", id, event, isNew);
}

export async function deleteEvent(uid: string, id: string) {
  await deleteAndQueue(uid, "events", id);
}

async function saveAndQueue(uid: string, collection: OfflineCollection, id: string, data: Record<string, unknown>, isNew = false) {
  validateCloudRecord(collection, data);
  const now = Date.now();
  // The document ID belongs in the Firestore path, not in its data payload.
  const recordData = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "id"));
  await saveLocalRecord(uid, collection, id, { ...recordData, ...(isNew && !("createdAt" in recordData) ? { createdAt: now } : {}), updatedAt: now });
}

function validateCloudRecord(collection: OfflineCollection, data: Record<string, unknown>) {
  const text = (key: string, min: number, max: number) => typeof data[key] === "string" && (data[key] as string).trim().length >= min && (data[key] as string).length <= max;
  const dateIsValid = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const periodIsValid = (data.academicSession === undefined || (typeof data.academicSession === "string" && /^\d{4}\/\d{4}$/.test(data.academicSession)))
    && (data.semester === undefined || ["First semester", "Second semester", "Extended semester"].includes(String(data.semester)));
  const timeIsValid = (value: unknown) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  let valid = true;
  if (collection === "courses") {
    valid = text("code", 1, 32) && text("name", 1, 160)
      && (data.creditUnits === undefined || (Number.isInteger(data.creditUnits) && Number(data.creditUnits) >= 1 && Number(data.creditUnits) <= 5))
      && (data.archived === undefined || typeof data.archived === "boolean")
      && (data.lecturerName === undefined || (typeof data.lecturerName === "string" && data.lecturerName.length <= 160))
      && (data.lectureVenue === undefined || (typeof data.lectureVenue === "string" && data.lectureVenue.length <= 160)) && periodIsValid;
  } else if (collection === "assignments") {
    valid = text("title", 1, 200) && typeof data.question === "string" && data.question.length <= 10_000
      && (data.description === undefined || (typeof data.description === "string" && data.description.length <= 10_000))
      && (data.studentId === undefined || (typeof data.studentId === "string" && data.studentId.length <= 80))
      && text("course", 1, 32) && text("due", 1, 80) && typeof data.completed === "boolean"
      && (data.dueDate === undefined || dateIsValid(data.dueDate)) && periodIsValid;
  } else if (collection === "schedules") {
    valid = text("courseCode", 1, 32) && ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].includes(String(data.day))
      && timeIsValid(data.start) && timeIsValid(data.end) && String(data.start) < String(data.end) && periodIsValid;
  } else if (collection === "exams") {
    valid = text("title", 1, 160) && text("courseCode", 1, 32)
      && dateIsValid(data.date)
      && timeIsValid(data.start) && (data.end === undefined || (timeIsValid(data.end) && String(data.end) > String(data.start)))
      && text("location", 1, 160) && periodIsValid;
  } else if (collection === "events") {
    valid = text("title", 1, 160) && typeof data.description === "string" && data.description.length <= 4_000
      && typeof data.scheduled === "boolean"
      && (!data.scheduled || (dateIsValid(data.date)
        && timeIsValid(data.start) && timeIsValid(data.end) && String(data.start) < String(data.end)
        && typeof data.location === "string" && data.location.length <= 160)) && periodIsValid;
  }
  if (!valid) throw new Error(`This ${collection === "studentSections" ? "student detail" : collection.slice(0, -1)} has invalid or incomplete fields. Review the highlighted values and try again.`);
}

async function deleteAndQueue(uid: string, collection: OfflineCollection, id: string) {
  await deleteLocalRecord(uid, collection, id);
}

export function recordData(snapshot: QuerySnapshot<DocumentData>) {
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}
