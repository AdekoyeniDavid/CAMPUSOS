function toPdfAscii(value: string) {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 32 && codePoint <= 126) result += character;
    else if (codePoint <= 0xffff) result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else {
      const adjusted = codePoint - 0x10000;
      result += `\\u${(0xd800 + (adjusted >> 10)).toString(16)}\\u${(0xdc00 + (adjusted & 0x3ff)).toString(16)}`;
    }
  }
  return result;
}

function wrap(line: string, width: number) {
  if (line.length <= width) return [line];
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const result: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(" ", width);
    if (splitAt <= indent.length) splitAt = width;
    result.push(remaining.slice(0, splitAt));
    remaining = `${indent}${remaining.slice(splitAt).trimStart()}`;
  }
  result.push(remaining);
  return result;
}

function pdfLiteral(text: string) {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** Build a readable, text-based PDF using the built-in Courier font. */
export function createTextPdf(title: string, lines: string[]) {
  const contentLines = [title, "", ...lines].flatMap((line) => wrap(toPdfAscii(line), 100));
  const linesPerPage = 60;
  const pages: string[][] = [];
  for (let index = 0; index < contentLines.length; index += linesPerPage) pages.push(contentLines.slice(index, index + linesPerPage));
  if (!pages.length) pages.push([toPdfAscii(title)]);

  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"];
  const pageRefs: string[] = [];
  pages.forEach((pageLines, index) => {
    const pageObject = 4 + index * 2;
    const streamObject = pageObject + 1;
    pageRefs.push(`${pageObject} 0 R`);
    const textCommands = ["BT", "/F1 8 Tf", "46 795 Td", "12 TL", ...pageLines.flatMap((line) => [`(${pdfLiteral(line)}) Tj`, "T*"]), "ET"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamObject} 0 R >>`);
    objects.push(`<< /Length ${textCommands.length} >>\nstream\n${textCommands}\nendstream`);
  });
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Blob([output], { type: "application/pdf" });
}

export type PdfReportSection = { title: string; rows: Array<{ label: string; value: string }> };

/** Render student records as a paginated, card-based report with a frosted-glass palette. */
export function createGlassReportPdf(title: string, subtitle: string, footer: string, sections: PdfReportSection[]) {
  const pages: string[][] = [];
  let commands: string[] = [];
  let y = 758;
  const drawText = (x: number, baseline: number, size: number, text: string, color: string, font = "F1") => {
    commands.push(`${color} rg BT /${font} ${size} Tf ${x} ${baseline} Td (${pdfLiteral(toPdfAscii(text))}) Tj ET`);
  };
  const beginPage = () => {
    commands = ["q 0.21 0.18 0.16 rg 0 772 595 70 re f Q"];
    drawText(44, 813, 17, title, "1 1 1", "F2");
    drawText(44, 795, 8, subtitle, "0.94 0.9 0.84");
    y = 758;
  };
  const endPage = () => {
    drawText(42, 31, 7, `Page ${pages.length + 1} | ${footer}`, "0.42 0.4 0.38");
    pages.push(commands);
  };
  const ensureSpace = (height: number) => {
    if (y - height < 54) { endPage(); beginPage(); }
  };
  beginPage();

  for (const section of sections) {
    ensureSpace(36);
    commands.push(`q 0.9 0.85 0.77 rg 40 ${y - 24} 515 23 re f Q`);
    commands.push(`q 0.72 0.64 0.53 RG 40 ${y - 24} 515 23 re S Q`);
    drawText(51, y - 16, 9, section.title, "0.28 0.23 0.19", "F2");
    y -= 31;
    const rows = section.rows.length ? section.rows : [{ label: "", value: "No saved records" }];
    for (const row of rows) {
      const valueLines = wrap(toPdfAscii(row.value || "-"), 92);
      const label = toPdfAscii(row.label);
      for (let offset = 0; offset < valueLines.length; offset += 48) {
        const labelLines = wrap(offset ? `${label} (continued)` : label, 92);
        const chunk = valueLines.slice(offset, offset + 48);
        const height = 12 + labelLines.length * 9 + chunk.length * 11;
        ensureSpace(height + 4);
        commands.push(`q 0.97 0.965 0.95 rg 0.84 0.81 0.77 RG 42 ${y - height} 511 ${height - 2} re B Q`);
        let textY = y - 11;
        for (const labelLine of labelLines) {
          drawText(52, textY, 7, labelLine, "0.43 0.4 0.37", "F2");
          textY -= 9;
        }
        for (const valueLine of chunk) {
          drawText(52, textY, 8.5, valueLine, "0.2 0.19 0.18");
          textY -= 11;
        }
        y -= height + 4;
      }
    }
    y -= 5;
  }
  endPage();

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  const pageRefs: string[] = [];
  pages.forEach((pageCommands, index) => {
    const pageObject = 5 + index * 2;
    const streamObject = pageObject + 1;
    const stream = pageCommands.join("\n");
    pageRefs.push(`${pageObject} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObject} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Blob([output], { type: "application/pdf" });
}
