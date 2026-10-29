import type { Backup } from "./backup.ts";
import { createGlassReportPdf, type PdfReportSection } from "./pdfExport.ts";
import { makeRestorablePdf } from "./backup.ts";

const sectionNames: Record<string, string> = {
  profile: "Student profile",
  institution: "Institution",
  personal: "Personal details",
  contact: "Contact details",
  academic: "Academic details",
  enrolment: "Enrolment",
  courses: "Registered courses",
  progress: "Academic progress",
};

const collectionNames = {
  courses: "Courses",
  assignments: "Assignments",
  schedules: "Weekly timetable",
  exams: "Exam timetable",
};

function labelFor(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  try { return JSON.stringify(value); } catch { return "[Value unavailable]"; }
}

function rowsFromObject(value: Record<string, unknown>, prefix = ""): PdfReportSection["rows"] {
  const rows: PdfReportSection["rows"] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const label = prefix ? `${prefix} - ${labelFor(key)}` : labelFor(key);
    if (item && typeof item === "object" && !Array.isArray(item)) {
      rows.push(...rowsFromObject(item as Record<string, unknown>, label));
    } else {
      rows.push({ label, value: displayValue(item) });
    }
  }
  return rows;
}

function rowsFromCollection(records: Array<{ id: string; data: Record<string, unknown> }>) {
  if (!records.length) return [{ label: "", value: "No saved records" }];
  return records.map(({ id, data }, index) => {
    const headingValue = data.title ?? data.name ?? data.courseCode ?? data.code ?? data.course;
    const label = typeof headingValue === "string" && headingValue.trim() ? headingValue : `Record ${index + 1} - ${id}`;
    const details = Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${labelFor(key)}: ${displayValue(value)}`)
      .join("  |  ");
    return { label, value: details || "No additional details" };
  });
}

export async function createBackupPdf(backup: Backup) {
  const sections: PdfReportSection[] = [{
    title: "Account summary",
    rows: [
      { label: "Student account", value: backup.studentUid },
      { label: "Backup created", value: backup.createdAt },
    ],
  }];

  for (const [key, section] of Object.entries(backup.student)) {
    if (key === "progress" && section && typeof section === "object" && !Array.isArray(section)) {
      const { studyNotes, gradeRecords, ...progress } = section as Record<string, unknown>;
      if (Object.keys(progress).length) sections.push({ title: sectionNames[key], rows: rowsFromObject(progress) });
      if (Array.isArray(studyNotes)) sections.push({ title: "Study notes & resources", rows: rowsFromCollection(studyNotes.map((data, index) => ({ id: String((data as Record<string, unknown>)?.id ?? index + 1), data: (data && typeof data === "object" && !Array.isArray(data) ? data : { content: data }) as Record<string, unknown> }))) });
      if (Array.isArray(gradeRecords)) sections.push({ title: "Grade records", rows: rowsFromCollection(gradeRecords.map((data, index) => ({ id: String((data as Record<string, unknown>)?.id ?? index + 1), data: (data && typeof data === "object" && !Array.isArray(data) ? data : { grade: data }) as Record<string, unknown> }))) });
      continue;
    }
    if (section && typeof section === "object" && !Array.isArray(section)) {
      sections.push({ title: sectionNames[key] ?? labelFor(key), rows: rowsFromObject(section as Record<string, unknown>) });
    }
  }

  for (const name of ["courses", "assignments", "schedules", "exams"] as const) {
    sections.push({ title: collectionNames[name], rows: rowsFromCollection(backup.collections[name]) });
  }
  const report = createGlassReportPdf("CampusOS Academic Backup", "Private student data | account backup", `Created ${backup.createdAt}   |   Keep this file secure`, sections);
  return makeRestorablePdf(report, backup);
}
