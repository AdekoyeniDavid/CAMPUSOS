import test from "node:test";
import assert from "node:assert/strict";

const { createTextPdf } = await import("../src/pdfExport.ts");

test("creates a valid multipage PDF and preserves non-ASCII text as readable escapes", async () => {
  const pdf = await createTextPdf("CampusOS Backup", ["Student: Zoë 📚", ...Array.from({ length: 70 }, (_, index) => `record ${index}: ${"course ".repeat(20)}`)]).text();
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /\\\\u00eb/);
  assert.match(pdf, /\\\\ud83d\\\\udcda/);
  assert.ok(Number(pdf.match(/\/Count (\d+)/)?.[1]) > 1);
  const xrefOffset = Number(pdf.match(/startxref\n(\d+)/)?.[1]);
  assert.equal(pdf.slice(xrefOffset, xrefOffset + 4), "xref");
  assert.match(pdf, /%%EOF\n$/);
});
