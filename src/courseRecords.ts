export type LocalCourseRecord = Record<string, unknown> & { id: string };

export type CourseRecord = {
  code: string;
  name: string;
  color: string;
  creditUnits?: number;
  lecturerName?: string;
  lectureVenue?: string;
  archived?: boolean;
  academicSession?: string;
  semester?: string;
  storageId?: string;
};

export function normalizeCourseRecords(records: LocalCourseRecord[]): CourseRecord[] {
  return records.map(({ id, ...data }) => ({
    code: typeof data.code === "string" && data.code.trim() ? data.code : id,
    name: typeof data.name === "string" && data.name.trim() ? data.name : "Course",
    color: typeof data.color === "string" && data.color.trim() ? data.color : "leather",
    creditUnits: typeof data.creditUnits === "number" && Number.isInteger(data.creditUnits) && data.creditUnits >= 1 && data.creditUnits <= 5
      ? data.creditUnits
      : undefined,
    ...(typeof data.lecturerName === "string" && data.lecturerName.trim() ? { lecturerName: data.lecturerName.trim() } : {}),
    ...(typeof data.lectureVenue === "string" && data.lectureVenue.trim() ? { lectureVenue: data.lectureVenue.trim() } : {}),
    archived: data.archived === true,
    academicSession: typeof data.academicSession === "string" && data.academicSession.trim() ? data.academicSession.trim() : undefined,
    semester: typeof data.semester === "string" && ["First semester", "Second semester", "Extended semester"].includes(data.semester) ? data.semester : undefined,
    storageId: id,
  }));
}
