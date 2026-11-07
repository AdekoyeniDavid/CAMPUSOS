import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { firebaseConfigured } from "./firebase";
import { createRecordId } from "./browser";
import { downloadStudyAttachmentFromCloud, mergeStudyItemsIntoSections, saveStudyRecord, studyRecordId } from "./firestore";
import { deleteLocalAttachment, getLocalAttachment, listLocalRecords, markLocalAttachmentCloudSynced, queueLocalAttachmentUpload, restoreLocalRecords, saveLocalAttachment, watchLocalRecords } from "./offlineStore";
import { parseBackupFile, recordsFromBackup, studyCollectionNames } from "./backup";
import type { Backup } from "./backup";
import { createBackupPdf } from "./backupPdf";
import { createStoredZip } from "./backupZip";
import { createTextPdf } from "./pdfExport";

type StudyAttachment = { id: string; name: string; size: number; type: string };
type Note = { id: string; title: string; category: string; content: string; resourceUrl: string; courseCode?: string; attachment?: StudyAttachment };
type AttachmentDeleteRequest = { attachment: StudyAttachment; source: "draft" } | { attachment: StudyAttachment; source: "saved" | "note"; noteId: string };
type Grade = { id: string; course: string; credits: number; letter: string; term: string };
type StudyCourse = { code: string; name: string };
type BackupFormat = "json" | "csv" | "pdf" | "zip";
const backupFormats: Array<{ id: BackupFormat; label: string; description: string }> = [
  { id: "json", label: "JSON", description: "Structured data that CampusOS can restore." },
  { id: "csv", label: "CSV", description: "Spreadsheet friendly tables for your academic records." },
  { id: "pdf", label: "PDF", description: "Readable report with a recovery payload." },
  { id: "zip", label: "ZIP", description: "Archive containing the restorable JSON and PDF report." },
];
const categories = ["Lecture notes", "Course outline", "Reading", "Research", "Resource link", "Other"];
const gradePoints: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
const emptyNote = { title: "", category: categories[0], content: "", resourceUrl: "", courseCode: "" };

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = /\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const output: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text))) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index));
    const key = `${match.index}-${match[0]}`;
    if (match[1]) output.push(<strong key={key}>{match[1]}</strong>);
    else if (match[2]) output.push(<em key={key}>{match[2]}</em>);
    else if (match[3]) output.push(<del key={key}>{match[3]}</del>);
    else if (match[4]) output.push(<code key={key}>{match[4]}</code>);
    else if (match[5] && match[6]) output.push(<a key={key} href={match[6]} target="_blank" rel="noreferrer">{match[5]}</a>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

function MarkdownContent({ content }: { content: string }) {
  return <div className="study-markdown-content">{content.split("\n").map((line, index) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length + 2}` as "h3" | "h4" | "h5";
      return <Tag key={index}>{renderInlineMarkdown(heading[2])}</Tag>;
    }
    const bulletItem = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numberedItem = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (bulletItem) return <p className="study-markdown-list-item" key={index}><span aria-hidden="true">•</span>{renderInlineMarkdown(bulletItem[1])}</p>;
    if (numberedItem) return <p className="study-markdown-list-item" key={index}><span aria-hidden="true">{numberedItem[1]}.</span>{renderInlineMarkdown(numberedItem[2])}</p>;
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return <blockquote key={index}>{renderInlineMarkdown(quote[1])}</blockquote>;
    return line ? <p key={index}>{renderInlineMarkdown(line)}</p> : <div className="study-markdown-spacer" key={index} aria-hidden="true" />;
  })}</div>;
}

function escapeEditorHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function markdownInlineToHtml(value: string) {
  return escapeEditorHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function markdownToEditorHtml(markdown: string) {
  if (!markdown) return "";
  const output: string[] = [];
  let listKind: "ul" | "ol" | null = null;
  let listItems: string[] = [];
  const flushList = () => {
    if (!listKind) return;
    output.push(`<${listKind}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${listKind}>`);
    listKind = null;
    listItems = [];
  };

  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (listKind !== kind) flushList();
      listKind = kind;
      listItems.push(markdownInlineToHtml((bullet ?? numbered)![1]));
      continue;
    }
    flushList();
    if (!line) output.push("<p><br></p>");
    else if (heading) output.push(`<h${heading[1].length + 2}>${markdownInlineToHtml(heading[2])}</h${heading[1].length + 2}>`);
    else if (quote) output.push(`<blockquote><p>${markdownInlineToHtml(quote[1]) || "<br>"}</p></blockquote>`);
    else output.push(`<p>${markdownInlineToHtml(line)}</p>`);
  }
  flushList();
  return output.join("") || "<p><br></p>";
}

function editorNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u00a0/g, " ");
  if (!(node instanceof HTMLElement)) return Array.from(node.childNodes, editorNodeToMarkdown).join("");
  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes, editorNodeToMarkdown).join("");
  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b" || node.style.fontWeight === "bold" || node.style.fontWeight === "700") return `**${children}**`;
  if (tag === "em" || tag === "i" || node.style.fontStyle === "italic") return `*${children}*`;
  if (tag === "code") return `\`${children}\``;
  if (tag === "del" || tag === "s" || tag === "strike") return `~~${children}~~`;
  if (tag === "a") {
    const href = node.getAttribute("href") ?? "";
    const label = children.replace(/\n+$/g, "").trim();
    if (!label) return "";
    return /^https?:\/\//i.test(href) ? `[${label}](${href})` : label;
  }
  if (/^h[1-5]$/.test(tag)) {
    const level = tag === "h3" ? "#" : tag === "h4" ? "##" : tag === "h5" ? "###" : "#";
    return `${level} ${children.trim()}\n`;
  }
  if (tag === "blockquote") return children.trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n";
  if (tag === "ul" || tag === "ol") {
    let number = 0;
    return Array.from(node.children).filter((child) => child.tagName.toLowerCase() === "li")
      .map((child) => `${tag === "ul" ? "-" : `${++number}.`} ${Array.from(child.childNodes, editorNodeToMarkdown).join("").trim()}`)
      .join("\n") + "\n";
  }
  if (tag === "li") return children;
  if (["div", "p"].includes(tag)) return children + "\n";
  return children;
}

function editorHtmlToMarkdown(editor: HTMLElement) {
  return Array.from(editor.childNodes, editorNodeToMarkdown).join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

function markdownToPdfLines(markdown: string) {
  return markdown.split("\n").map((line) => line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "- ")
    .replace(/^\s*\d+[.)]\s+/, "- ")
    .replace(/^>\s?/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, "$1"));
}

export function StudyTools({ page, studentUid, currentAcademicSession, currentAcademicSemester, connected, online, cloudMessage, recordCounts, courses, searchTargetId }: {
  page: string;
  studentUid: string;
  currentAcademicSession: string;
  currentAcademicSemester: string;
  connected: boolean;
  online: boolean;
  cloudMessage: string;
  recordCounts: Record<string, number>;
  courses: StudyCourse[];
  searchTargetId?: string | null;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [form, setForm] = useState(emptyNote);
  const [editorPreview, setEditorPreview] = useState(false);
  const [activeEditorFormats, setActiveEditorFormats] = useState<Record<string, boolean>>({});
  const [formatMotion, setFormatMotion] = useState<{ command: string; enabled: boolean } | null>(null);
  const noteContentRef = useRef<HTMLDivElement>(null);
  const noteSelectionRef = useRef<Range | null>(null);
  const noteEditorInternalValueRef = useRef<string | null>(null);
  const linkTypingModeRef = useRef(false);
  const linkTypingHrefRef = useRef("https://example.com");
  const activeLinkNodeRef = useRef<HTMLAnchorElement | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [draftAttachment, setDraftAttachment] = useState<StudyAttachment | null>(null);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentDeleteRequest, setAttachmentDeleteRequest] = useState<AttachmentDeleteRequest | null>(null);
  const [attachmentDeleteBusy, setAttachmentDeleteBusy] = useState(false);
  const [noteDeleteRequest, setNoteDeleteRequest] = useState<Note | null>(null);
  const [noteDeleteBusy, setNoteDeleteBusy] = useState(false);
  const [gradeDeleteRequest, setGradeDeleteRequest] = useState<Grade | null>(null);
  const [gradeDeleteBusy, setGradeDeleteBusy] = useState(false);
  const [noteFilter, setNoteFilter] = useState("All materials");
  const [courseFilter, setCourseFilter] = useState("All courses");
  const [search, setSearch] = useState("");
  const gradePeriodLabel = `${currentAcademicSession} · ${currentAcademicSemester}`;
  const [gradeDraft, setGradeDraft] = useState({ course: "", credits: "", letter: "A" });
  const [databaseError, setDatabaseError] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [backupFormatOpen, setBackupFormatOpen] = useState(false);
  const [backupFormatConfirmation, setBackupFormatConfirmation] = useState<BackupFormat | null>(null);
  const [backupFormat, setBackupFormat] = useState<BackupFormat | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreData, setRestoreData] = useState<Backup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoringBusy, setRestoringBusy] = useState(false);

  useEffect(() => {
    linkTypingModeRef.current = false;
    activeLinkNodeRef.current = null;
    setForm(emptyNote);
    setEditorPreview(false);
    setEditingNoteId(null);
    setDraftAttachment(null);
    setAttachmentFile(null);
    setGradeDraft({ course: "", credits: "", letter: "A" });
  }, [studentUid, currentAcademicSession, currentAcademicSemester]);

  useLayoutEffect(() => {
    if (editorPreview) return;
    const editor = noteContentRef.current;
    if (!editor) return;
    if (noteEditorInternalValueRef.current === form.content) {
      noteEditorInternalValueRef.current = null;
      return;
    }
    editor.innerHTML = markdownToEditorHtml(form.content);
    noteSelectionRef.current = null;
  }, [form.content, editorPreview, editingNoteId]);

  useEffect(() => {
    const localUnsubscribe = watchLocalRecords(studentUid, "studentSections", (records) => {
      const validPeriod = /^\d{4}\/\d{4}$/.test(currentAcademicSession) && ["First semester", "Second semester", "Extended semester"].includes(currentAcademicSemester);
      const notesId = validPeriod ? studyRecordId("studyNotes", currentAcademicSession, currentAcademicSemester) : "__no_current_academic_period__";
      const gradesId = validPeriod ? studyRecordId("gradeRecords", currentAcademicSession, currentAcademicSemester) : "__no_current_academic_period__";
      const notesRecord = records.find((item) => item.id === notesId);
      const gradesRecord = records.find((item) => item.id === gradesId);
      if (Array.isArray(notesRecord?.["value"])) setNotes(notesRecord["value"] as Note[]);
      else setNotes([]);
      if (Array.isArray(gradesRecord?.["value"])) setGrades(gradesRecord["value"] as Grade[]);
      else setGrades([]);
    });
    if (!firebaseConfigured) { setDatabaseError("Firebase is not configured. Study records are available only on this device."); return localUnsubscribe; }
    setDatabaseError("");
    return localUnsubscribe;
  }, [studentUid, currentAcademicSession, currentAcademicSemester]);

  useEffect(() => {
    if (!attachmentDeleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !attachmentDeleteBusy) setAttachmentDeleteRequest(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [attachmentDeleteRequest, attachmentDeleteBusy]);

  useEffect(() => {
    if (!noteDeleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !noteDeleteBusy) setNoteDeleteRequest(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [noteDeleteRequest, noteDeleteBusy]);

  useEffect(() => {
    if (!gradeDeleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !gradeDeleteBusy) setGradeDeleteRequest(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [gradeDeleteRequest, gradeDeleteBusy]);

  useEffect(() => {
    if (page !== "Notes & Resources" || !searchTargetId) return;
    setSearch("");
    setNoteFilter("All materials");
    setCourseFilter("All courses");
    const timer = window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>(".study-note[data-search-id]"))
        .find((element) => element.dataset.searchId === searchTargetId);
      if (!target) return;
      target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.classList.add("search-result-focus");
      window.setTimeout(() => target.classList.remove("search-result-focus"), 1800);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [page, searchTargetId, notes]);

  const cgpa = useMemo(() => {
    const creditTotal = grades.reduce((sum, item) => sum + item.credits, 0);
    const pointsTotal = grades.reduce((sum, item) => sum + (gradePoints[item.letter] ?? 0) * item.credits, 0);
    return { value: creditTotal ? (pointsTotal / creditTotal).toFixed(2) : "0.00", credits: creditTotal, points: pointsTotal };
  }, [grades]);
  const courseByCode = useMemo(() => new Map(courses.map((course) => [course.code, course])), [courses]);
  const materialCountByCourse = useMemo(() => notes.reduce((counts, note) => {
    if (note.courseCode) counts.set(note.courseCode, (counts.get(note.courseCode) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()), [notes]);
  const linkedCourseCodes = useMemo(() => Array.from(new Set([...courses.map((course) => course.code), ...notes.flatMap((note) => note.courseCode ? [note.courseCode] : [])])).sort(), [courses, notes]);
  const matchingNotes = useMemo(() => notes.filter((note) => (noteFilter === "All materials" || note.category === noteFilter)
    && (courseFilter === "All courses" || (courseFilter === "Unassigned" ? !note.courseCode : note.courseCode === courseFilter))
    && `${note.title} ${note.content} ${note.category} ${note.courseCode ?? ""}`.toLowerCase().includes(search.toLowerCase())), [notes, noteFilter, courseFilter, search]);

  async function saveNotes(next: Note[]) {
    if (new Blob([JSON.stringify(next)]).size > 400_000) throw new Error("Your study notes are over the safe per-account storage limit. Remove large attachments and try again.");
    await queueStudyRecord("studyNotes", next);
  }

  async function saveGrades(next: Grade[]) {
    await queueStudyRecord("gradeRecords", next);
  }

  async function queueStudyRecord(field: "studyNotes" | "gradeRecords", value: unknown[]) {
    if (!/^\d{4}\/\d{4}$/.test(currentAcademicSession) || !["First semester", "Second semester", "Extended semester"].includes(currentAcademicSemester)) {
      throw new Error("Set a current academic year and semester in Student Account → Academic Details before saving study records.");
    }
    await saveStudyRecord(studentUid, field, value, currentAcademicSession, currentAcademicSemester);
  }

  async function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDatabaseError("");
    if (form.resourceUrl) {
      try {
        const url = new URL(form.resourceUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        setDatabaseError("Resource links must use a valid https:// or http:// address.");
        return;
      }
    }
    const noteId = editingNoteId ?? createRecordId();
    const previousAttachment = editingNoteId ? notes.find((item) => item.id === editingNoteId)?.attachment : undefined;
    let attachmentStored = false;
    try {
      if (attachmentFile && draftAttachment) {
        await saveLocalAttachment(studentUid, draftAttachment.id, attachmentFile);
        attachmentStored = true;
      }
      const { courseCode, ...noteFields } = form;
      const nextNote: Note = { id: noteId, ...noteFields, ...(courseCode ? { courseCode } : {}), ...(draftAttachment ? { attachment: draftAttachment } : {}) };
      const next = editingNoteId ? notes.map((item) => item.id === editingNoteId ? nextNote : item) : [nextNote, ...notes];
      try { await saveNotes(next); }
      catch (error) {
        if (attachmentStored && draftAttachment) await deleteLocalAttachment(studentUid, draftAttachment.id).catch(() => undefined);
        throw error;
      }
      if (attachmentStored && draftAttachment) {
        await queueLocalAttachmentUpload(studentUid, draftAttachment.id);
      }
      if (previousAttachment && previousAttachment.id !== draftAttachment?.id) void deleteLocalAttachment(studentUid, previousAttachment.id, true).catch(() => undefined);
      setNotes(next);
      setForm(emptyNote); setEditingNoteId(null); setDraftAttachment(null); setAttachmentFile(null);
      setEditorPreview(false);
      setDatabaseError("");
    } catch (error) { setDatabaseError(error instanceof Error ? error.message : "The note could not be saved locally. Check available device storage and try again."); }
  }

  function clearNoteForm() {
    linkTypingModeRef.current = false;
    activeLinkNodeRef.current = null;
    setActiveEditorFormats((current) => ({ ...current, link: false }));
    setForm(emptyNote);
    setEditorPreview(false);
    setEditingNoteId(null);
    setDraftAttachment(null);
    setAttachmentFile(null);
    setDatabaseError("");
  }

  function rememberNoteSelection() {
    const editor = noteContentRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      noteSelectionRef.current = range.cloneRange();
      refreshEditorFormats(range.startContainer);
    }
  }

  function refreshEditorFormats(container?: Node) {
    const editor = noteContentRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : noteSelectionRef.current;
    // Input events pass the editable root as `container`; use the actual
    // caret position first so formats such as link stay on while typing.
    const anchor = range?.startContainer ?? container;
    const insideEditor = !!anchor && editor.contains(anchor);
    if (!insideEditor) return;
    const active: Record<string, boolean> = {};
    active.link = linkTypingModeRef.current;
    let node: Node | null = anchor;
    while (node && node !== editor) {
      if (node instanceof HTMLElement) {
        const tag = node.tagName.toLowerCase();
        active.heading ||= /^h[1-6]$/.test(tag);
        active.quote ||= tag === "blockquote";
        active.code ||= tag === "code";
        active.link ||= tag === "a";
        active.bold ||= tag === "strong" || tag === "b" || node.style.fontWeight === "bold" || node.style.fontWeight === "700";
        active.italic ||= tag === "em" || tag === "i" || node.style.fontStyle === "italic";
      }
      node = node.parentNode;
    }
    setActiveEditorFormats(active);
  }

  function applyActiveInlineFormats(textNode: Text, editor: HTMLElement) {
    // Link typing is handled manually so it can remain a persistent mode.
    // Reapply independently enabled inline marks to each inserted text run;
    // otherwise the custom link insertion would bypass the browser's native
    // bold/italic typing state.
    const selection = window.getSelection();
    let node: Node | null = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
    const inherited = { bold: false, italic: false };
    while (node && node !== editor) {
      if (node instanceof HTMLElement) {
        const tag = node.tagName.toLowerCase();
        inherited.bold ||= tag === "strong" || tag === "b" || node.style.fontWeight === "bold" || node.style.fontWeight === "700";
        inherited.italic ||= tag === "em" || tag === "i" || node.style.fontStyle === "italic";
      }
      node = node.parentNode;
    }

    let content: Node = textNode;
    if (activeEditorFormats.italic && !inherited.italic) {
      const italic = document.createElement("em");
      italic.append(content);
      content = italic;
    }
    if (activeEditorFormats.bold && !inherited.bold) {
      const bold = document.createElement("strong");
      bold.append(content);
      content = bold;
    }
    return content;
  }

  function editorFormatButtonClass(command: string) {
    const active = !!activeEditorFormats[command];
    const motion = formatMotion?.command === command ? ` format-motion-${formatMotion.enabled ? "on" : "off"}` : "";
    return `${active ? "format-active" : ""}${motion}`.trim();
  }

  function applyEditorCommand(command: string, value?: string) {
    const editor = noteContentRef.current;
    if (!editor) return;
    // Focus before restoring the saved range. Some mobile browsers collapse
    // selections when focus changes, so restoring after focus is important.
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (noteSelectionRef.current && editor.contains(noteSelectionRef.current.commonAncestorContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(noteSelectionRef.current);
    } else if (!selection?.rangeCount || !editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    // Read the state after restoring the editor selection so a second tap
    // reverses the style at that same caret or selected text.
    let currentlyActive = false;
    if (command === "link") currentlyActive = linkTypingModeRef.current;
    const currentRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    let activeNode: Node | null = currentRange?.startContainer ?? null;
    while (!currentlyActive && activeNode && activeNode !== editor) {
      if (activeNode instanceof HTMLElement) {
        const tag = activeNode.tagName.toLowerCase();
        currentlyActive = command === "heading" ? /^h[1-6]$/.test(tag)
          : command === "quote" ? tag === "blockquote"
            : command === "code" ? tag === "code"
              : command === "link" ? tag === "a"
                : command === "bold" ? tag === "strong" || tag === "b" || activeNode.style.fontWeight === "bold" || activeNode.style.fontWeight === "700"
                  : command === "italic" ? tag === "em" || tag === "i" || activeNode.style.fontStyle === "italic"
                    : command === "insertUnorderedList" ? tag === "ul"
                      : command === "insertOrderedList" ? tag === "ol"
                : false;
      }
      activeNode = activeNode.parentNode;
    }

    if (command === "code") {
      const selectedText = window.getSelection()?.toString() ?? "";
      if (currentlyActive) {
        if (selectedText) document.execCommand("insertHTML", false, escapeEditorHtml(selectedText));
        else document.execCommand("removeFormat");
      } else {
        document.execCommand("insertHTML", false, `<code>${escapeEditorHtml(selectedText || "code")}</code>`);
      }
    } else if (command === "link") {
      if (currentlyActive) {
        linkTypingModeRef.current = false;
        activeLinkNodeRef.current = null;
        if (selection && !selection.isCollapsed) {
          document.execCommand("unlink");
        } else {
          let linkNode: Node | null = currentRange?.startContainer ?? null;
          while (linkNode && linkNode !== editor && !(linkNode instanceof HTMLAnchorElement)) linkNode = linkNode.parentNode;
          if (linkNode instanceof HTMLAnchorElement && linkNode.parentNode) {
            const parent = linkNode.parentNode;
            const linkIndex = Array.prototype.indexOf.call(parent.childNodes, linkNode);
            const movedChildCount = linkNode.childNodes.length;
            while (linkNode.firstChild) parent.insertBefore(linkNode.firstChild, linkNode);
            linkNode.remove();
            const caretAfterLink = document.createRange();
            caretAfterLink.setStart(parent, Math.max(0, linkIndex + movedChildCount));
            caretAfterLink.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(caretAfterLink);
          } else {
            document.execCommand("unlink");
          }
        }
      } else if (selection?.isCollapsed) {
        const insertionRange = selection.getRangeAt(0);
        insertionRange.deleteContents();
        const emptyLink = document.createElement("a");
        emptyLink.href = value ?? "https://example.com";
        emptyLink.rel = "noreferrer";
        insertionRange.insertNode(emptyLink);
        linkTypingModeRef.current = true;
        linkTypingHrefRef.current = emptyLink.href;
        activeLinkNodeRef.current = emptyLink;
        const descriptionRange = document.createRange();
        descriptionRange.setStart(emptyLink, 0);
        descriptionRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(descriptionRange);
      }
      if (!currentlyActive && !selection?.isCollapsed) {
        const href = value ?? "https://example.com";
        document.execCommand("createLink", false, href);
        let linkNode: Node | null = window.getSelection()?.anchorNode ?? null;
        while (linkNode && linkNode !== editor && !(linkNode instanceof HTMLAnchorElement)) linkNode = linkNode.parentNode;
        linkTypingModeRef.current = true;
        linkTypingHrefRef.current = href;
        activeLinkNodeRef.current = linkNode instanceof HTMLAnchorElement ? linkNode : null;
      }
    } else if (command === "heading") {
      document.execCommand("formatBlock", false, currentlyActive ? "p" : "h4");
    } else if (command === "quote") {
      document.execCommand("formatBlock", false, currentlyActive ? "p" : "blockquote");
    } else {
      document.execCommand(command, false, value);
    }

    const content = editorHtmlToMarkdown(editor);
    if (content.length > 15000) {
      setDatabaseError("Formatting would exceed the 15,000-character note limit. Shorten the text and try again.");
      return;
    }
    noteEditorInternalValueRef.current = content;
    setForm((current) => ({ ...current, content }));
    setDatabaseError("");
    const resultingSelection = window.getSelection();
    if (resultingSelection?.rangeCount) {
      const resultingRange = resultingSelection.getRangeAt(0);
      if (editor.contains(resultingRange.commonAncestorContainer)) noteSelectionRef.current = resultingRange.cloneRange();
    }
    const toggleableFormats = ["bold", "italic", "heading", "insertUnorderedList", "insertOrderedList", "quote", "code", "link"];
    if (toggleableFormats.includes(command)) {
      const enabled = !currentlyActive;
      // Keep the toolbar in sync with this tap; selectionchange can briefly
      // report the old state in browsers that collapse the selection.
      setActiveEditorFormats((current) => ({ ...current, [command]: enabled }));
      setFormatMotion({ command, enabled });
    }
  }

  function handleEditorInput(event: FormEvent<HTMLDivElement>) {
    syncEditorContent(event.currentTarget);
  }

  function syncEditorContent(editor: HTMLDivElement) {
    const content = editorHtmlToMarkdown(editor);
    if (content.length > 15000) {
      setDatabaseError("Notes are limited to 15,000 characters.");
      return;
    }
    noteEditorInternalValueRef.current = content;
    setForm((current) => ({ ...current, content }));
    setDatabaseError("");
    rememberNoteSelection();
    refreshEditorFormats(editor);
  }

  function handleEditorBeforeInput(event: FormEvent<HTMLDivElement>) {
    if (!linkTypingModeRef.current) return;
    const input = event.nativeEvent as InputEvent;
    if (input.isComposing) return;
    const editor = event.currentTarget;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    let text: string | null = null;
    const enter = input.inputType === "insertParagraph" || input.inputType === "insertLineBreak";
    if (input.inputType === "insertText") text = input.data;
    else if (input.inputType === "insertFromPaste") text = input.dataTransfer?.getData("text/plain") ?? null;
    if (!enter && text === null) return;

    event.preventDefault();
    range.deleteContents();
    let linkNode: HTMLAnchorElement | null = null;
    const currentLink = activeLinkNodeRef.current;
    if (currentLink && editor.contains(currentLink) && currentLink.contains(range.startContainer)) linkNode = currentLink;
    if (!linkNode) {
      linkNode = document.createElement("a");
      linkNode.href = linkTypingHrefRef.current;
      linkNode.rel = "noreferrer";
      range.insertNode(linkNode);
      range.setStart(linkNode, 0);
      range.collapse(true);
      activeLinkNodeRef.current = linkNode;
    }

    if (enter) {
      const lineBreak = document.createElement("br");
      range.insertNode(lineBreak);
      range.setStartAfter(lineBreak);
    } else {
      const textNode = document.createTextNode(text ?? "");
      const formattedText = applyActiveInlineFormats(textNode, editor);
      range.insertNode(formattedText);
      range.setStartAfter(formattedText);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    noteSelectionRef.current = range.cloneRange();
    syncEditorContent(editor);
  }

  function handleEditorPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const editor = event.currentTarget;
    const text = event.clipboardData.getData("text/plain");
    if (!linkTypingModeRef.current) {
      document.execCommand("insertText", false, text);
      return;
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const currentLink = activeLinkNodeRef.current;
    let linkNode = currentLink && editor.contains(currentLink) && currentLink.contains(range.startContainer) ? currentLink : null;
    if (!linkNode) {
      linkNode = document.createElement("a");
      linkNode.href = linkTypingHrefRef.current;
      linkNode.rel = "noreferrer";
      range.insertNode(linkNode);
      range.setStart(linkNode, 0);
      range.collapse(true);
      activeLinkNodeRef.current = linkNode;
    }
    const pastedText = document.createTextNode(text);
    const formattedText = applyActiveInlineFormats(pastedText, editor);
    range.insertNode(formattedText);
    range.setStartAfter(formattedText);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    noteSelectionRef.current = range.cloneRange();
    syncEditorContent(editor);
  }

  function exportNotePdf(note: Pick<Note, "title" | "category" | "content" | "resourceUrl" | "courseCode" | "attachment">) {
    const lines = [
      `Category: ${note.category}`,
      ...(note.courseCode ? [`Course: ${note.courseCode}`] : []),
      ...(note.resourceUrl ? [`Resource link: ${note.resourceUrl}`] : []),
      ...(note.attachment ? [`Attachment: ${note.attachment.name}`] : []),
      "",
      ...markdownToPdfLines(note.content),
    ];
    const safeTitle = note.title.trim().replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-|-$/g, "").slice(0, 64) || "study-note";
    downloadBlob(createTextPdf(note.title.trim() || "Study note", lines), `campusos-${safeTitle}.pdf`);
  }

  async function selectStudyAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const allowedExtensions = new Set(["pdf", "doc", "docx", "odt", "rtf", "txt", "pages"]);
    if (!allowedExtensions.has(extension)) { setDatabaseError("Choose a PDF or document file (PDF, DOC, DOCX, ODT, RTF, TXT, or Pages)."); return; }
    if (!file.size || file.size > 20 * 1024 * 1024) { setDatabaseError("Documents must be smaller than 20 MB."); return; }
    try {
      const sample = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const startsWith = (...bytes: number[]) => bytes.every((value, index) => sample[index] === value);
      const headerText = new TextDecoder("utf-8", { fatal: false }).decode(sample);
      const validSignature = extension === "pdf" ? headerText.startsWith("%PDF-")
        : extension === "doc" ? startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
        : ["docx", "odt", "pages"].includes(extension) ? startsWith(0x50, 0x4b, 0x03, 0x04)
        : extension === "rtf" ? headerText.startsWith("{\\rtf")
        : !sample.includes(0);
      if (!validSignature) throw new Error("The file content does not match its extension. Choose a valid PDF or document file.");
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : "This document could not be checked safely.");
      return;
    }
    setAttachmentFile(file);
    setDraftAttachment({ id: createRecordId(), name: file.name, size: file.size, type: file.type });
    setDatabaseError("");
  }

  async function downloadStudyAttachment(attachment: StudyAttachment) {
    try {
      let blob = await getLocalAttachment(studentUid, attachment.id);
      if (!blob) {
        blob = await downloadStudyAttachmentFromCloud(studentUid, attachment.id);
        await saveLocalAttachment(studentUid, attachment.id, blob);
        await markLocalAttachmentCloudSynced(studentUid, attachment.id);
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = attachment.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      setDatabaseError(code === "storage/object-not-found"
        ? "This document is not available yet."
        : error instanceof Error ? error.message : "The saved document could not be opened.");
    }
  }

  async function confirmAttachmentDelete() {
    const request = attachmentDeleteRequest;
    if (!request || attachmentDeleteBusy) return;
    setAttachmentDeleteBusy(true);
    try {
    if (request.source === "draft") {
      setDraftAttachment(null);
      setAttachmentFile(null);
      setAttachmentDeleteRequest(null);
      return;
    }
    const current = notes.find((note) => note.id === request.noteId);
    if (!current || current.attachment?.id !== request.attachment.id) { setAttachmentDeleteRequest(null); return; }
    const next: Note[] = request.source === "note"
      ? notes.filter((note) => note.id !== request.noteId)
      : notes.map((note) => note.id === request.noteId ? { ...note, attachment: undefined } : note);
    try {
      await saveNotes(next);
      setNotes(next);
      if (editingNoteId === request.noteId && draftAttachment?.id === request.attachment.id) { setDraftAttachment(null); setAttachmentFile(null); }
      await deleteLocalAttachment(studentUid, request.attachment.id, true);
      if (request.source === "note" && editingNoteId === request.noteId) { setEditingNoteId(null); setForm(emptyNote); setDraftAttachment(null); setAttachmentFile(null); }
      setDatabaseError("");
      setAttachmentDeleteRequest(null);
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : "The document could not be deleted. Try again.");
    }
    } finally { setAttachmentDeleteBusy(false); }
  }

  async function removeNote(id: string) {
    const noteWithAttachment = notes.find((item) => item.id === id);
    if (!noteWithAttachment) return;
    if (noteWithAttachment?.attachment) {
      setAttachmentDeleteRequest({ source: "note", noteId: noteWithAttachment.id, attachment: noteWithAttachment.attachment });
      return;
    }
    setNoteDeleteRequest(noteWithAttachment);
  }

  async function confirmNoteDelete() {
    const request = noteDeleteRequest;
    if (!request || noteDeleteBusy) return;
    setNoteDeleteBusy(true);
    try {
      const next = notes.filter((item) => item.id !== request.id);
      await saveNotes(next);
      setNotes(next);
      setDatabaseError("");
      setNoteDeleteRequest(null);
    } catch {
      setDatabaseError("The study material could not be saved locally. Check available device storage and try again.");
    } finally {
      setNoteDeleteBusy(false);
    }
  }

  async function addGrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const grade: Grade = { id: createRecordId(), course: gradeDraft.course.trim(), credits: Number(gradeDraft.credits), letter: gradeDraft.letter, term: gradePeriodLabel };
    if (!grade.course || !Number.isFinite(grade.credits) || grade.credits <= 0 || grade.credits > 50) return;
    try { const next = [grade, ...grades]; await saveGrades(next); setGrades(next); setGradeDraft({ course: "", credits: "", letter: "A" }); setDatabaseError(""); }
    catch { setDatabaseError("The grade record could not be saved locally. Check available device storage and try again."); }
  }

  function removeGrade(id: string) {
    const grade = grades.find((item) => item.id === id);
    if (grade) setGradeDeleteRequest(grade);
  }

  async function confirmGradeDelete() {
    const request = gradeDeleteRequest;
    if (!request || gradeDeleteBusy) return;
    setGradeDeleteBusy(true);
    try {
      const next = grades.filter((item) => item.id !== request.id);
      await saveGrades(next);
      setGrades(next);
      setDatabaseError("");
      setGradeDeleteRequest(null);
    } catch {
      setDatabaseError("The grade record could not be saved locally. Check available device storage and try again.");
    } finally {
      setGradeDeleteBusy(false);
    }
  }

  async function collectBackup(): Promise<Backup> {
    await mergeStudyItemsIntoSections(studentUid);
    const [sectionRecords, ...collections] = await Promise.all([
      listLocalRecords(studentUid, "studentSections"),
      ...studyCollectionNames.map((name) => listLocalRecords(studentUid, name)),
    ]);
    const student: Record<string, unknown> = {};
    for (const { id, ...data } of sectionRecords) {
      if (id !== "studyNotes" && id !== "gradeRecords") student[id] = data;
    }
    const progress = student.progress && typeof student.progress === "object" ? { ...(student.progress as Record<string, unknown>) } : {};
    const notes = sectionRecords.find(({ id }) => id === "studyNotes")?.["value"];
    const grades = sectionRecords.find(({ id }) => id === "gradeRecords")?.["value"];
    if (Array.isArray(notes)) progress.studyNotes = notes;
    if (Array.isArray(grades)) progress.gradeRecords = grades;
    if (Object.keys(progress).length) student.progress = progress;
    if (!Object.keys(student).length) throw new Error("No student records are saved on this device yet. Connect once to load your account data, then try again.");
    return {
      app: "CampusOS", version: 1, studentUid, createdAt: new Date().toISOString(),
      student: Object.fromEntries(Object.entries(student).filter(([key]) => key !== "authorizedStaffUids" && key !== "createdAt")),
      collections: Object.fromEntries(studyCollectionNames.map((name, index) => [
        name,
        collections[index].map(({ id, ...data }) => ({ id, data })),
      ])) as Backup["collections"],
    };
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function backupCsv(backup: Backup) {
    const rows: string[][] = [["section", "record_id", "field", "value"]];
    const append = (section: string, id: string, data: unknown) => {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data)) rows.push([section, id, key, typeof value === "string" ? value : JSON.stringify(value)]);
      } else rows.push([section, id, "value", typeof data === "string" ? data : JSON.stringify(data)]);
    };
    for (const [section, data] of Object.entries(backup.student)) append(section, "", data);
    for (const [collection, records] of Object.entries(backup.collections)) for (const record of records ?? []) append(collection, record.id, record.data);
    return new Blob(["\uFEFF" + rows.map((row) => row.map((value) => `"${(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  }

  async function downloadBackup(format: BackupFormat) {
    setBackupBusy(true);
    setBackupMessage("Preparing your academic data backup…");
    try {
      const backup = await collectBackup();
      const date = new Date().toISOString().slice(0, 10);
      const json = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      if (format === "json") downloadBlob(json, `campusos-backup-${date}.json`);
      else if (format === "csv") downloadBlob(backupCsv(backup), `campusos-backup-${date}.csv`);
      else {
        const pdf = await createBackupPdf(backup);
        if (format === "pdf") downloadBlob(pdf, `campusos-backup-${date}.pdf`);
        else downloadBlob(await createStoredZip([{ name: `campusos-backup-${date}.json`, blob: json }, { name: `campusos-backup-${date}.pdf`, blob: pdf }]), `campusos-backup-${date}.zip`);
      }
      setBackupMessage(`${format.toUpperCase()} academic backup downloaded.`);
      setBackupFormatConfirmation(null);
      setBackupFormatOpen(false);
      setBackupFormat(null);
    } catch (error) { setBackupMessage(error instanceof Error ? error.message : "The backup could not be created. Check available storage and try again."); }
    finally { setBackupBusy(false); }
  }

  async function readBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBackupMessage(""); setRestoreData(null);
    try {
      const parsed = await parseBackupFile(file, studentUid);
      setRestoreData(parsed); setBackupMessage(`Backup ready: ${recordsFromBackup(parsed).length} saved records can be restored.`);
    } catch (error) { setBackupMessage(error instanceof Error ? error.message : "This backup file could not be read."); }
  }

  async function restoreBackup() {
    if (!restoreData) return;
    setRestoringBusy(true); setBackupMessage("");
    try {
      const records = recordsFromBackup(restoreData);
      await restoreLocalRecords(studentUid, records);
      setRestoreData(null); setRestoring(false); setBackupMessage("");
    } catch (error) { setBackupMessage(error instanceof Error ? `Recovery could not be saved locally: ${error.message}` : "Recovery could not be saved locally. Check device storage and retry."); }
    finally { setRestoringBusy(false); }
  }

  function startCourseMaterial(course: StudyCourse) {
    setForm({ ...emptyNote, courseCode: course.code });
    setEditorPreview(false);
    setEditingNoteId(null);
    setDraftAttachment(null);
    setAttachmentFile(null);
    setDatabaseError("");
    requestAnimationFrame(() => {
      const formElement = document.querySelector<HTMLFormElement>(".study-form-notes");
      formElement?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      formElement?.querySelector<HTMLInputElement>("[name='study-material-title']")?.focus({ preventScroll: true });
    });
  }

  return <section className="study-tools-page">
    {gradeDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!gradeDeleteBusy && event.target === event.currentTarget) setGradeDeleteRequest(null); }}><section className="attachment-delete-dialog grade-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="grade-delete-title" aria-describedby="grade-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">GRADE RECORD REMOVAL</p><h2 id="grade-delete-title">Delete this grade?</h2><p id="grade-delete-description">Remove the <strong>{gradeDeleteRequest.course}</strong> record ({gradeDeleteRequest.letter}, {gradeDeleteRequest.credits} credit {gradeDeleteRequest.credits === 1 ? "unit" : "units"}) from your grade calculator? This cannot be undone.</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={gradeDeleteBusy} onClick={() => setGradeDeleteRequest(null)}>Keep grade</button><button type="button" className="attachment-delete-confirm" disabled={gradeDeleteBusy} onClick={() => void confirmGradeDelete()}>{gradeDeleteBusy ? "Deleting…" : "Delete grade"}</button></div></section></div>}
    {noteDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!noteDeleteBusy && event.target === event.currentTarget) setNoteDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="study-delete-title" aria-describedby="study-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">STUDY MATERIAL REMOVAL</p><h2 id="study-delete-title">Delete this study material?</h2><p id="study-delete-description"><strong>{noteDeleteRequest.title}</strong> will be deleted from this device and account. This action cannot be undone.</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={noteDeleteBusy} onClick={() => setNoteDeleteRequest(null)}>Keep material</button><button type="button" className="attachment-delete-confirm" disabled={noteDeleteBusy} onClick={() => void confirmNoteDelete()}>{noteDeleteBusy ? "Deleting…" : "Delete material"}</button></div></section></div>}
    {attachmentDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!attachmentDeleteBusy && event.target === event.currentTarget) setAttachmentDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="attachment-delete-title" aria-describedby="attachment-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">DOCUMENT REMOVAL</p><h2 id="attachment-delete-title">Delete this PDF or document?</h2><p id="attachment-delete-description"><strong>{attachmentDeleteRequest.attachment.name}</strong>{attachmentDeleteRequest.source === "note" ? " and its study material will be deleted from this device and account." : attachmentDeleteRequest.source === "draft" && editingNoteId ? " will be removed from this material when you save your changes." : attachmentDeleteRequest.source === "draft" ? " will be removed from this new material." : " will be deleted from this device and removed from the material."}</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={attachmentDeleteBusy} onClick={() => setAttachmentDeleteRequest(null)}>Keep document</button><button type="button" className="attachment-delete-confirm" disabled={attachmentDeleteBusy} onClick={() => void confirmAttachmentDelete()}>{attachmentDeleteBusy ? "Deleting…" : attachmentDeleteRequest.source === "note" ? "Delete material and file" : "Delete document"}</button></div></section></div>}
    {databaseError && <p className="study-feedback study-error" role="alert">{databaseError}</p>}
    {page === "Notes & Resources" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>Study materials</h2><p>Courses from My Courses sync here automatically. Add an outline, notes, links, or documents for each course.</p></div><span className="study-count-pill">{notes.length} saved</span></div>
      <div className="study-period-banner liquid-glass"><span>Current academic period</span><strong>{currentAcademicSession} · {currentAcademicSemester}</strong></div>
      <section className="course-material-library liquid-glass" aria-label="Registered courses and materials">
        <div className="course-material-library-heading"><div><h3>Your registered courses</h3><p>Choose a course to add its outline or study material.</p></div><span>{courses.length} courses</span></div>
        {courses.length ? <div className="course-material-course-grid">{courses.map((course) => {
          const courseMaterialCount = materialCountByCourse.get(course.code) ?? 0;
          return <article className="course-material-course liquid-glass" key={course.code}><div><strong>{course.code}</strong><span>{course.name}</span></div><small>{courseMaterialCount} {courseMaterialCount === 1 ? "material" : "materials"}</small><button type="button" className="course-material-add" onClick={() => startCourseMaterial(course)}>＋ Add materials</button></article>;
        })}</div> : <p className="course-material-empty">Add courses in My Courses and they will appear here automatically.</p>}
      </section>
      <form className="assignment-form study-form study-form-notes" onSubmit={(event) => void submitNote(event)}>
        <label>Title<input name="study-material-title" value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Week 3 lecture notes" maxLength={120} required /></label>
        <label>Course<select value={form.courseCode} onChange={(event) => setForm((current) => ({ ...current, courseCode: event.target.value }))}><option value="">Not linked to a course</option>{courses.map((course) => <option key={course.code} value={course.code}>{course.code} · {course.name}</option>)}{form.courseCode && !courses.some((course) => course.code === form.courseCode) && <option value={form.courseCode}>{form.courseCode} · previously linked</option>}</select></label>
        <label>Organize as<select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <div className="study-wide study-editor-field">
          <div className="study-editor-heading"><span>Notes or resource description <small>Select text and format it · 15,000 characters</small></span><div className="study-editor-tabs" role="group" aria-label="Editor view"><button type="button" className={!editorPreview ? "active" : ""} aria-pressed={!editorPreview} onClick={() => setEditorPreview(false)}>Write</button><button type="button" className={editorPreview ? "active" : ""} aria-pressed={editorPreview} onClick={() => setEditorPreview(true)}>Preview</button></div></div>
          {!editorPreview && <div className="study-editor-surface liquid-glass">
            <div className="study-markdown-toolbar" role="toolbar" aria-label="Text formatting" onPointerDownCapture={rememberNoteSelection}>
              <button type="button" className={editorFormatButtonClass("bold")} title="Bold" aria-label="Bold" aria-pressed={!!activeEditorFormats.bold} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("bold")}><strong>B</strong><span className="format-state-label">{activeEditorFormats.bold ? "On" : ""}</span></button>
              <button type="button" className={editorFormatButtonClass("italic")} title="Italic" aria-label="Italic" aria-pressed={!!activeEditorFormats.italic} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("italic")}><em>I</em><span className="format-state-label">{activeEditorFormats.italic ? "On" : ""}</span></button>
              <button type="button" className={editorFormatButtonClass("heading")} title="Heading" aria-label="Heading" aria-pressed={!!activeEditorFormats.heading} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("heading")}>H</button>
              <button type="button" className={editorFormatButtonClass("insertUnorderedList")} title="Bulleted list" aria-label="Bulleted list" aria-pressed={!!activeEditorFormats.insertUnorderedList} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("insertUnorderedList")}>• List</button>
              <button type="button" className={editorFormatButtonClass("insertOrderedList")} title="Numbered list" aria-label="Numbered list" aria-pressed={!!activeEditorFormats.insertOrderedList} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("insertOrderedList")}>1. List</button>
              <button type="button" className={editorFormatButtonClass("quote")} title="Quote" aria-label="Quote" aria-pressed={!!activeEditorFormats.quote} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("quote")}>❝</button>
              <button type="button" className={editorFormatButtonClass("code")} title="Inline code" aria-label="Inline code" aria-pressed={!!activeEditorFormats.code} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("code")}>{"</>"}</button>
              <button type="button" className={editorFormatButtonClass("link")} title="Link" aria-label="Link" aria-pressed={!!activeEditorFormats.link} onMouseDown={(event) => event.preventDefault()} onClick={() => applyEditorCommand("link")}>↗ Link</button>
            </div>
            <div ref={noteContentRef} role="textbox" aria-multiline="true" aria-label="Notes or resource description" data-placeholder="Write a summary, key concepts, or study instructions…" contentEditable suppressContentEditableWarning spellCheck onBeforeInput={handleEditorBeforeInput} onInput={handleEditorInput} onKeyUp={rememberNoteSelection} onPointerUp={rememberNoteSelection} onBlur={rememberNoteSelection} onPointerDownCapture={rememberNoteSelection} onPaste={handleEditorPaste} />
          </div>}
          {editorPreview && <div className="study-markdown-preview liquid-glass" aria-label="Formatted note preview">{form.content.trim() ? <MarkdownContent content={form.content} /> : <p className="study-preview-empty">Formatted text will appear here as you write.</p>}</div>}
        </div>
        <label className="study-wide">Resource link (optional)<input type="url" value={form.resourceUrl} onChange={(event) => setForm((current) => ({ ...current, resourceUrl: event.target.value }))} placeholder="https://…" maxLength={1000} /></label>
        <div className="study-attachment-field study-wide"><span>Document attachment <small>PDF or document · up to 20 MB · saved on this device</small></span><label className="study-attachment-picker liquid-glass"><span aria-hidden="true">↥</span>{draftAttachment ? "Replace document" : "Upload PDF or document"}<input type="file" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,.pages,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={selectStudyAttachment} aria-label="Upload a PDF or document" /></label>{draftAttachment && <div className="study-attachment-preview liquid-glass"><span aria-hidden="true">▤</span><span className="study-attachment-name">{draftAttachment.name}<small>{(draftAttachment.size / (1024 * 1024)).toFixed(2)} MB · saved when you save this material</small></span><button type="button" className="study-action destructive" aria-label="Remove attached document" onClick={() => setAttachmentDeleteRequest({ source: "draft", attachment: draftAttachment })}>Remove</button></div>}</div>
        <div className="study-form-actions"><button className="primary-button" type="submit">{editingNoteId ? "Save changes" : "Save material"}</button><button type="button" className="study-editor-export liquid-glass" disabled={!form.title.trim() && !form.content.trim()} onClick={() => exportNotePdf({ ...form, title: form.title.trim() || "Study note" })}>Export PDF</button><button type="button" className="study-clear-button liquid-glass" onClick={clearNoteForm} aria-label="Clear all study material fields"><span aria-hidden="true">⌫</span>Clear fields</button>{editingNoteId && <button type="button" className="profile-cancel" onClick={clearNoteForm}>Cancel</button>}</div>
      </form>
      <div className="study-filter-row"><input aria-label="Search study materials" placeholder="Search materials…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Filter materials by category" value={noteFilter} onChange={(event) => setNoteFilter(event.target.value)}><option>All materials</option>{categories.map((category) => <option key={category}>{category}</option>)}</select><select aria-label="Filter materials by course" value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}><option>All courses</option><option>Unassigned</option>{linkedCourseCodes.map((code) => <option key={code} value={code}>{code}{!courses.some((course) => course.code === code) ? " · previous course" : ""}</option>)}</select></div>
      <div className="study-note-list">{matchingNotes.map((note) => { const linkedCourse = note.courseCode ? courseByCode.get(note.courseCode) : undefined; return <article className="study-note liquid-glass" key={note.id} data-search-id={note.id}><div className="study-note-top"><span className="study-category">{note.category}</span><div><button type="button" className="study-action" onClick={() => { setForm({ title: note.title, category: note.category, content: note.content, resourceUrl: note.resourceUrl, courseCode: note.courseCode ?? "" }); setEditorPreview(false); setDraftAttachment(note.attachment ?? null); setAttachmentFile(null); setEditingNoteId(note.id); }}>Edit</button><button type="button" className="study-action destructive" onClick={() => void removeNote(note.id)}>Delete</button></div></div>{note.courseCode && <span className="study-course-tag">{linkedCourse?.code ?? note.courseCode}{linkedCourse?.name ? ` · ${linkedCourse.name}` : ""}</span>}<h3>{note.title}</h3>{note.content && <MarkdownContent content={note.content} />}{note.resourceUrl && <a href={note.resourceUrl} target="_blank" rel="noreferrer">Open resource ↗</a>}<button type="button" className="study-action study-note-pdf" onClick={() => exportNotePdf(note)}>Export PDF</button>{note.attachment && <div className="study-attached-document-row"><button type="button" className="study-attached-document liquid-glass" onClick={() => void downloadStudyAttachment(note.attachment!)}><span aria-hidden="true">▤</span><span>{note.attachment.name}<small>Download · {(note.attachment.size / (1024 * 1024)).toFixed(2)} MB</small></span><span aria-hidden="true">↓</span></button><button type="button" className="study-action destructive study-attachment-delete" onClick={() => setAttachmentDeleteRequest({ source: "saved", noteId: note.id, attachment: note.attachment! })}>Delete document</button></div>}</article>; })}{matchingNotes.length === 0 && <p className="empty-state">No materials match. Add a note or resource to start organizing your study library.</p>}</div>
    </section>}

    {page === "Grade Calculator" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>CGPA calculator</h2><p>Track course grades using a 5.0 scale (A=5, B=4, C=3, D=2, E=1, F=0).</p></div><span className="study-count-pill">{grades.length} courses</span></div>
      <div className="study-period-banner liquid-glass"><span>Current academic period</span><strong>{currentAcademicSession} · {currentAcademicSemester}</strong></div>
      <div className="cgpa-summary liquid-glass"><div><span>Current CGPA</span><strong>{cgpa.value}</strong><small>out of 5.00</small></div><div><span>Credits counted</span><strong>{cgpa.credits}</strong><small>weighted credit units</small></div><div><span>Quality points</span><strong>{cgpa.points.toFixed(1)}</strong><small>grade points × credits</small></div></div>
      <form className="assignment-form study-form grade-form" onSubmit={(event) => void addGrade(event)}>
        <label>Course<input value={gradeDraft.course} onChange={(event) => setGradeDraft((current) => ({ ...current, course: event.target.value }))} placeholder="Course code or title" maxLength={120} required /></label>
        <label>Credit units<input type="number" min="0.5" max="50" step="0.5" value={gradeDraft.credits} onChange={(event) => setGradeDraft((current) => ({ ...current, credits: event.target.value }))} required /></label>
        <label>Grade<select value={gradeDraft.letter} onChange={(event) => setGradeDraft((current) => ({ ...current, letter: event.target.value }))}>{Object.entries(gradePoints).map(([letter, points]) => <option key={letter} value={letter}>{letter} · {points.toFixed(1)} points</option>)}</select></label>
        <label className="grade-period-field">Session / semester<input value={gradePeriodLabel} readOnly aria-readonly="true" /><small className="grade-period-hint">Automatically follows Student Account → Academic Details.</small></label>
        <button className="primary-button" type="submit">Add grade</button>
      </form>
      <div className="grade-record-list">{grades.map((grade) => <article className="grade-record" key={grade.id}><div><strong>{grade.course}</strong><span>{grade.term || "Session not specified"} · {grade.credits} credit {grade.credits === 1 ? "unit" : "units"}</span></div><span className="grade-badge">{grade.letter} · {(gradePoints[grade.letter] ?? 0).toFixed(1)}</span><button className="study-action destructive" type="button" aria-label={`Delete grade for ${grade.course}`} onClick={() => void removeGrade(grade.id)}>Delete</button></article>)}{grades.length === 0 && <p className="empty-state">Add completed or current courses to start tracking your CGPA.</p>}</div>
    </section>}

    {page === "Cloud Database" && <section className="panel study-panel">
      <div className="section-heading cloud-database-heading"><div><h2>Your cloud database</h2><p>CampusOS stores academic records in Firestore and uploaded study documents in private Firebase Storage.</p></div><span className={`cloud-status-pill ${!online ? "offline" : connected ? "connected" : "connecting"}`} role="status" aria-live="polite" aria-atomic="true">● {!online ? "Offline" : connected ? "Connected" : "Connecting"}</span></div>
      <div className="database-explainer liquid-glass"><span className="database-icon">☁</span><div><h3>Private, account-scoped storage</h3><p>Records sync to your signed-in student account and load across devices. Firebase security rules restrict access to your own student record.</p></div></div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{cloudMessage}</span>
      <div className="database-count-grid">{Object.entries({ Courses: recordCounts.courses ?? 0, Assignments: recordCounts.assignments ?? 0, Schedules: recordCounts.schedules ?? 0, Exams: recordCounts.exams ?? 0, Events: recordCounts.events ?? 0, "Notes & resources": notes.length, "Grade records": grades.length }).map(([label, count]) => <article className="database-count liquid-glass" key={label}><span>{label}</span><strong>{count}</strong></article>)}</div>
      <p className="study-footnote">Study notes and grade records are saved with your student record in Firestore. Use Backup &amp; Recovery to download a portable copy of your academic information.</p>
    </section>}

    {page === "Backup & Recovery" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>Backup &amp; recovery</h2><p>Download a portable copy or restore a backup to your cloud account.</p></div><span className="study-count-pill">Your account only</span></div>
      <div className="backup-card liquid-glass"><div className="backup-symbol">⇩</div><div><h3>Download your academic data</h3><p>Choose a format for your profile, courses, assignments, timetable, exams, notes, resources, and grades. Attached file contents sync separately and aren’t embedded in these backups.</p><div className="backup-download-actions"><button className="primary-button" type="button" onClick={() => { setBackupMessage(""); setBackupFormatOpen(true); }}>Download academic data</button></div><small className="backup-format-note">JSON, PDF, and ZIP include data that CampusOS can restore. CSV is designed for spreadsheets. Keep downloaded files private.</small></div></div>
      <div className="backup-card liquid-glass"><div className="backup-symbol recovery">↥</div><div><h3>Recover from a backup</h3><p>Choose a CampusOS PDF or JSON backup for this signed-in account. Restoring merges saved information; records with matching IDs are updated and other current records are kept.</p><label className="backup-file-label">Choose PDF or JSON backup<input type="file" accept="application/pdf,.pdf,application/json,.json" onChange={(event) => void readBackup(event)} /></label><small className="backup-format-note">Older report-only PDFs do not include recovery data. Download a new PDF backup from this version to make it restorable.</small>{restoreData && <div className="restore-confirm"><span>Ready to restore the backup for this account.</span><button className="primary-button" type="button" disabled={restoringBusy} onClick={() => setRestoring(true)}>{restoringBusy ? "Restoring…" : "Restore backup"}</button><button className="profile-cancel" type="button" onClick={() => { setRestoreData(null); setRestoring(false); }}>Cancel</button>{restoring && <div className="restore-confirm-warning"><p>Confirm recovery? Records with matching IDs will be updated. Other current records will remain.</p><button type="button" className="primary-button" disabled={restoringBusy} onClick={() => void restoreBackup()}>Confirm recovery</button><button type="button" className="profile-cancel" onClick={() => setRestoring(false)}>Go back</button></div>}</div>}</div></div>
      {backupMessage && <p className="study-feedback" role="status">{backupMessage}</p>}
      <p className="study-footnote">Backups contain private academic information. Keep downloaded files in a secure location and do not share them.</p>
      {backupFormatOpen && <div className="backup-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !backupBusy) setBackupFormatOpen(false); }}><section className="backup-dialog liquid-glass" role="dialog" aria-modal="true" aria-labelledby="backup-format-title"><button type="button" className="backup-dialog-close" aria-label="Close format selection" onClick={() => setBackupFormatOpen(false)} disabled={backupBusy}>×</button><p className="profile-kicker">BACKUP &amp; RECOVERY</p><h3 id="backup-format-title">Choose a file type</h3><p>Select how you want your academic data downloaded.</p><div className="backup-format-options">{backupFormats.map((format) => <button key={format.id} type="button" className={`backup-format-option${backupFormat === format.id ? " selected" : ""}`} aria-pressed={backupFormat === format.id} onClick={() => { setBackupFormat(format.id); setBackupFormatConfirmation(format.id); }}><strong>{format.label}</strong><span>{format.description}</span></button>)}</div>{backupBusy && <p role="status" className="backup-format-status">Preparing download…</p>}</section></div>}
      {backupFormatConfirmation && <div className="backup-dialog-backdrop backup-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !backupBusy) setBackupFormatConfirmation(null); }}><section className="backup-dialog backup-confirm-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="backup-confirm-title" aria-describedby="backup-confirm-description"><button type="button" className="backup-dialog-cancel" disabled={backupBusy} onClick={() => { setBackupFormatConfirmation(null); setBackupFormatOpen(false); setBackupFormat(null); }}>Cancel</button><span className="backup-dialog-symbol">⇩</span><p className="profile-kicker">CONFIRM DOWNLOAD</p><h3 id="backup-confirm-title">Download as {backupFormatConfirmation.toUpperCase()}?</h3><p id="backup-confirm-description">{backupFormats.find((format) => format.id === backupFormatConfirmation)?.description} Your private academic data will be saved to this device.</p><div className="backup-dialog-actions"><button type="button" className="profile-cancel" disabled={backupBusy} onClick={() => setBackupFormatConfirmation(null)}>Choose another</button><button type="button" className="primary-button" disabled={backupBusy} onClick={() => void downloadBackup(backupFormatConfirmation)}>{backupBusy ? "Preparing…" : `Download ${backupFormatConfirmation.toUpperCase()}`}</button></div></section></div>}
    </section>}
  </section>;
}
