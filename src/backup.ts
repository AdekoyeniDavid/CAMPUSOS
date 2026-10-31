import type { OfflineCollection, LocalRestoreRecord } from "./offlineStore.ts";

export type BackupCollection = Exclude<OfflineCollection, "studentSections">;
export type Backup = {
  app: "CampusOS";
  version: 1;
  studentUid: string;
  createdAt: string;
  student: Record<string, unknown>;
  collections: Partial<Record<BackupCollection, Array<{ id: string; data: Record<string, unknown> }>>>;
};

export const studyCollectionNames: BackupCollection[] = ["courses", "assignments", "schedules", "exams", "events"];
const pdfBackupStart = "%CampusOSBackupV1Begin";
const pdfBackupEnd = "%CampusOSBackupV1End";
const pdfBackupChunkPrefix = "%CampusOSBackupData:";
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
  if (collection === "events") return text("title", 1, 160) && text("description", 0, 4000)
    && typeof data.scheduled === "boolean"
    && (!data.scheduled || (text("date", 10, 10) && text("start", 5, 5) && text("end", 5, 5) && text("location", 0, 160)));
  return text("title", 1, 160) && text("courseCode", 1, 32) && text("date", 10, 10) && text("start", 5, 5)
    && (data.end === undefined || (text("end", 5, 5) && (data.end as string) > (data.start as string)))
    && text("location", 1, 160);
}

export function validateBackup(value: unknown, uid: string): value is Backup {
  if (!isRecord(value) || value.app !== "CampusOS" || value.version !== 1 || value.studentUid !== uid
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !isRecord(value.student) || !isRecord(value.collections)) return false;
  if (Object.keys(value.student).some((key) => !studentSections.includes(key))
    || !Object.entries(value.student).every(([key, section]) => studentSections.includes(key) && isRecord(section) && safeJsonValue(section))) return false;
  const collections = value.collections as Record<string, unknown>;
  if (!studyCollectionNames.every((name) => (name === "events" && collections[name] === undefined) || (Array.isArray(collections[name]) && collections[name].length <= 1000))) return false;
  for (const name of studyCollectionNames) {
    const seen = new Set<string>();
    for (const item of (collections[name] ?? []) as unknown[]) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 150 || item.id.includes("/")
        || !isRecord(item.data) || !safeJsonValue(item.data) || !validItem(name, item.id, item.data)) return false;
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      try { if (new TextEncoder().encode(JSON.stringify(item.data)).byteLength > 900_000) return false; } catch { return false; }
    }
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 9_500_000; } catch { return false; }
}

function encodeBase64(bytes: Uint8Array) {
  const chunks: string[] = [];
  // Keep each chunk divisible by three so joining encoded chunks preserves base64 padding.
  const chunkSize = 24_576;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (let index = 0; index < chunk.length; index++) binary += String.fromCharCode(chunk[index]);
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(value: string) {
  if (!globalThis.crypto?.subtle) return "";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Attach a machine-readable, checksummed copy as PDF comments after %%EOF. */
export async function makeRestorablePdf(pdf: Blob, backup: Backup) {
  const json = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(json);
  const payload = encodeBase64(bytes);
  const checksum = await sha256Hex(json);
  const dataLines = payload.match(/.{1,3000}/g) ?? [];
  const metadata = [
    pdfBackupStart,
    `%CampusOSBackupSha256:${checksum || "unavailable"}`,
    ...dataLines.map((line) => `${pdfBackupChunkPrefix}${line}`),
    pdfBackupEnd,
  ].join("\n");
  return new Blob([pdf, "\n", metadata, "\n"], { type: "application/pdf" });
}

/** Read a JSON backup or a CampusOS PDF that contains its structured recovery payload. */
export async function parseBackupFile(file: File, uid: string): Promise<Backup> {
  if (file.size > 30_000_000) throw new Error("This backup is larger than 30 MB and cannot be restored here.");
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  let parsed: unknown;
  if (isPdf) {
    const content = await file.text();
    const start = content.lastIndexOf(pdfBackupStart);
    const end = content.indexOf(pdfBackupEnd, start);
    if (start < 0 || end < 0) {
      throw new Error("This PDF is a readable report without recovery data. Download a new PDF backup from CampusOS to make it restorable.");
    }
    const metadata = content.slice(start, end);
    const checksum = metadata.match(/^%CampusOSBackupSha256:([a-f0-9]{64}|unavailable)$/m)?.[1];
    const payload = Array.from(metadata.matchAll(/^%CampusOSBackupData:([A-Za-z0-9+/=]+)$/gm), (match) => match[1]).join("");
    if (!checksum || !payload || payload.length > 20_000_000) throw new Error("The recovery data in this PDF is incomplete or too large to read.");
    const json = decodeBase64(payload);
    if (checksum !== "unavailable" && await sha256Hex(json) !== checksum) {
      throw new Error("The recovery data in this PDF failed its integrity check. Choose another backup file.");
    }
    parsed = JSON.parse(json);
  } else {
    parsed = JSON.parse(await file.text());
  }
  if (!validateBackup(parsed, uid)) throw new Error("Choose a valid CampusOS backup made for this signed-in account.");
  return parsed;
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
    for (const item of backup.collections[collection] ?? []) {
      records.push({ collection, id: item.id, data: { ...item.data, updatedAt: Date.now() } });
    }
  }
  return records;
}
