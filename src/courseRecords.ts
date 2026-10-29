export type LocalCourseRecord = Record<string, unknown> & { id: string };

export type CourseRecord = {
  code: string;
  name: string;
  color: string;
  creditUnits?: number;
};

export function normalizeCourseRecords(records: LocalCourseRecord[]): CourseRecord[] {
  return records.map(({ id, ...data }) => ({
    code: typeof data.code === "string" && data.code.trim() ? data.code : id,
    name: typeof data.name === "string" && data.name.trim() ? data.name : "Course",
    color: typeof data.color === "string" && data.color.trim() ? data.color : "leather",
    creditUnits: typeof data.creditUnits === "number" && Number.isInteger(data.creditUnits) && data.creditUnits >= 1 && data.creditUnits <= 5
      ? data.creditUnits
      : undefined,
  }));
}
