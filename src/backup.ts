import type { OfflineCollection, LocalRestoreRecord } from "./offlineStore.ts";

export type BackupCollection = Exclude<OfflineCollection, "studentSections">;
export type Backup = {
  app: "CampusOS";
  version: 1;
  studentUid: string;
  createdAt: string;
  student: Record<string, unknown>;
  collections: Record<BackupCollection, Array<{ id: string; data: Record<string, unknown> }>>;
};

export const studyCollectionNames: BackupCollection[] = ["courses", "assignments", "schedules", "exams"];
const studentSections = ["profile", "institution", "personal", "contact", "academic", "enrolment", "courses", "progress"];
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => safeJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => !forbiddenKeys.has(key) && safeJsonValue(item, depth + 1));
}

function validItem(collection: BackupCollection, id: string, data: Record<string, unknown>) {
  const text = (key: string, min: number, max: number) => typeof data[key] === "string" && (data[key] as string).length >= min && (data[key] as string).length <= max;
  if (collection === "courses") return text("code", 1, 32) && data.code === id && text("name", 1, 160);
  if (collection === "assignments") return text("title", 1, 200) && text("question", 0, 10_000)
    && text("due", 1, 80) && (data.completed === undefined || typeof data.completed === "boolean")
    && (data.id === undefined || data.id === id);
  if (collection === "schedules") return text("courseCode", 1, 32) && text("day", 1, 20) && text("start", 1, 20) && text("end", 1, 20);
  return text("title", 1, 160) && text("courseCode", 1, 32) && text("date", 10, 10) && text("start", 5, 5) && text("location", 1, 160);
}

export function validateBackup(value: unknown, uid: string): value is Backup {
  if (!isRecord(value) || value.app !== "CampusOS" || value.version !== 1 || value.studentUid !== uid
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !isRecord(value.student) || !isRecord(value.collections)) return false;
  if (Object.keys(value.student).some((key) => !studentSections.includes(key))
    || !Object.entries(value.student).every(([key, section]) => studentSections.includes(key) && isRecord(section) && safeJsonValue(section))) return false;
  const collections = value.collections as Record<string, unknown>;
  if (!studyCollectionNames.every((name) => Array.isArray(collections[name]) && collections[name].length <= 1000)) return false;
  for (const name of studyCollectionNames) {
    const seen = new Set<string>();
    for (const item of collections[name] as unknown[]) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 150 || item.id.includes("/")
        || !isRecord(item.data) || !safeJsonValue(item.data) || !validItem(name, item.id, item.data)) return false;
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      try { if (new TextEncoder().encode(JSON.stringify(item.data)).byteLength > 900_000) return false; } catch { return false; }
    }
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 9_500_000; } catch { return false; }
}

export function recordsFromBackup(backup: Backup): LocalRestoreRecord[] {
  const records: LocalRestoreRecord[] = [];
  for (const [id, section] of Object.entries(backup.student)) {
    const data = { ...(section as Record<string, unknown>) };
    if (id === "progress") {
      const progress = data;
      delete progress.studyNotes;
      delete progress.gradeRecords;
      if (Array.isArray((section as Record<string, unknown>).studyNotes)) records.push({ collection: "studentSections", id: "studyNotes", data: { value: (section as Record<string, unknown>).studyNotes as unknown } });
      if (Array.isArray((section as Record<string, unknown>).gradeRecords)) records.push({ collection: "studentSections", id: "gradeRecords", data: { value: (section as Record<string, unknown>).gradeRecords as unknown } });
    }
    records.push({ collection: "studentSections", id, data });
  }
  for (const collection of studyCollectionNames) {
    for (const item of backup.collections[collection]) {
      records.push({ collection, id: item.id, data: { ...item.data, updatedAt: Date.now() } });
    }
  }
  return records;
}
