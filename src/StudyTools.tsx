import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { firebaseConfigured } from "./firebase";
import { createRecordId } from "./browser";
import { saveStudyRecord } from "./firestore";
import { deleteLocalAttachment, getLocalAttachment, listLocalRecords, pendingWriteCount, restoreLocalRecords, saveLocalAttachment, syncPendingWrites, watchLocalRecords } from "./offlineStore";
import { parseBackupFile, recordsFromBackup, studyCollectionNames } from "./backup";
import type { Backup } from "./backup";
import { createBackupPdf } from "./backupPdf";

type StudyAttachment = { id: string; name: string; size: number; type: string };
type Note = { id: string; title: string; category: string; content: string; resourceUrl: string; attachment?: StudyAttachment };
type AttachmentDeleteRequest = { attachment: StudyAttachment; source: "draft" } | { attachment: StudyAttachment; source: "saved" | "note"; noteId: string };
type Grade = { id: string; course: string; credits: number; letter: string; term: string };
const categories = ["Lecture notes", "Reading", "Research", "Resource link", "Other"];
const gradePoints: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
const emptyNote = { title: "", category: categories[0], content: "", resourceUrl: "" };

export function StudyTools({ page, studentUid, connected, online, syncPending, cloudMessage, recordCounts, searchTargetId }: {
  page: string;
  studentUid: string;
  connected: boolean;
  online: boolean;
  syncPending: boolean;
  cloudMessage: string;
  recordCounts: Record<string, number>;
  searchTargetId?: string | null;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [form, setForm] = useState(emptyNote);
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
  const [search, setSearch] = useState("");
  const [gradeDraft, setGradeDraft] = useState({ course: "", credits: "", letter: "A", term: "" });
  const [databaseError, setDatabaseError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [studySavePending, setStudySavePending] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [restoreData, setRestoreData] = useState<Backup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoringBusy, setRestoringBusy] = useState(false);

  useEffect(() => {
    const localUnsubscribe = watchLocalRecords(studentUid, "studentSections", (records) => {
      const notesRecord = records.find((item) => item.id === "studyNotes");
      const gradesRecord = records.find((item) => item.id === "gradeRecords");
      if (Array.isArray(notesRecord?.["value"])) setNotes(notesRecord["value"] as Note[]);
      if (Array.isArray(gradesRecord?.["value"])) setGrades(gradesRecord["value"] as Grade[]);
    });
    if (!firebaseConfigured) { setDatabaseError("Firebase is not configured. Study records are available only on this device."); return localUnsubscribe; }
    setDatabaseError("");
    return localUnsubscribe;
  }, [studentUid]);

  useEffect(() => {
    if (!studySavePending) return;
    const checkSync = () => {
      void pendingWriteCount(studentUid, "studentSections").then((count) => {
        if (count === 0) {
          setStudySavePending(false);
          setSaveMessage("Saved on this device and synced to Firestore.");
        }
      });
    };
    window.addEventListener("campusos-sync", checkSync);
    checkSync();
    return () => window.removeEventListener("campusos-sync", checkSync);
  }, [studentUid, studySavePending]);

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

  async function saveNotes(next: Note[]) {
    if (new Blob([JSON.stringify(next)]).size > 400_000) throw new Error("Your study notes are over the safe per-account storage limit. Remove large attachments and try again.");
    await queueStudyRecord("studyNotes", next);
  }

  async function saveGrades(next: Grade[]) {
    await queueStudyRecord("gradeRecords", next);
  }

  async function queueStudyRecord(field: "studyNotes" | "gradeRecords", value: unknown[]) {
    setStudySavePending(true);
    await saveStudyRecord(studentUid, field, value);
    setSaveMessage("Saved on this device. Firestore sync will retry automatically.");
    const pending = await pendingWriteCount(studentUid, "studentSections");
    if (pending === 0) {
      setStudySavePending(false);
      setSaveMessage("Saved on this device and synced to Firestore.");
    }
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
      const nextNote: Note = { id: noteId, ...form, ...(draftAttachment ? { attachment: draftAttachment } : {}) };
      const next = editingNoteId ? notes.map((item) => item.id === editingNoteId ? nextNote : item) : [nextNote, ...notes];
      try { await saveNotes(next); }
      catch (error) {
        if (attachmentStored && draftAttachment) await deleteLocalAttachment(studentUid, draftAttachment.id).catch(() => undefined);
        throw error;
      }
      if (previousAttachment && previousAttachment.id !== draftAttachment?.id) void deleteLocalAttachment(studentUid, previousAttachment.id).catch(() => undefined);
      setNotes(next);
      setForm(emptyNote); setEditingNoteId(null); setDraftAttachment(null); setAttachmentFile(null);
      setDatabaseError("");
    } catch (error) { setStudySavePending(false); setDatabaseError(error instanceof Error ? error.message : "The note could not be saved locally. Check available device storage and try again."); }
  }

  function selectStudyAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const allowedExtensions = new Set(["pdf", "doc", "docx", "odt", "rtf", "txt", "pages"]);
    if (!allowedExtensions.has(extension)) { setDatabaseError("Choose a PDF or document file (PDF, DOC, DOCX, ODT, RTF, TXT, or Pages)."); return; }
    if (!file.size || file.size > 20 * 1024 * 1024) { setDatabaseError("Documents must be smaller than 20 MB."); return; }
    setAttachmentFile(file);
    setDraftAttachment({ id: createRecordId(), name: file.name, size: file.size, type: file.type });
    setDatabaseError("");
  }

  async function downloadStudyAttachment(attachment: StudyAttachment) {
    try {
      const blob = await getLocalAttachment(studentUid, attachment.id);
      if (!blob) throw new Error("This attachment is saved on the device where it was added and is not available in this browser.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = attachment.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) { setDatabaseError(error instanceof Error ? error.message : "The saved document could not be opened."); }
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
      await deleteLocalAttachment(studentUid, request.attachment.id);
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
      setStudySavePending(false);
      setDatabaseError("The study material could not be saved locally. Check available device storage and try again.");
    } finally {
      setNoteDeleteBusy(false);
    }
  }

  async function addGrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const grade: Grade = { id: createRecordId(), course: gradeDraft.course.trim(), credits: Number(gradeDraft.credits), letter: gradeDraft.letter, term: gradeDraft.term.trim() };
    if (!grade.course || !Number.isFinite(grade.credits) || grade.credits <= 0 || grade.credits > 50) return;
    try { const next = [grade, ...grades]; await saveGrades(next); setGrades(next); setGradeDraft({ course: "", credits: "", letter: "A", term: "" }); setDatabaseError(""); }
    catch { setStudySavePending(false); setDatabaseError("The grade record could not be saved locally. Check available device storage and try again."); }
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
      setStudySavePending(false);
      setDatabaseError("The grade record could not be saved locally. Check available device storage and try again.");
    } finally {
      setGradeDeleteBusy(false);
    }
  }

  async function collectBackup(): Promise<Backup> {
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

  async function downloadBackup() {
    setBackupMessage("Preparing your PDF backup from this device…");
    try {
      const backup = await collectBackup();
      downloadBlob(await createBackupPdf(backup), `campusos-backup-${new Date().toISOString().slice(0, 10)}.pdf`);
      setBackupMessage("Restorable PDF backup downloaded.");
    } catch (error) { setBackupMessage(error instanceof Error ? error.message : "The backup could not be created. Check your connection and try again."); }
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
      if (navigator.onLine) void syncPendingWrites(studentUid);
      setRestoreData(null); setRestoring(false); setBackupMessage("Recovery saved on this device. Existing records were kept, and changes will sync to Firestore when connected.");
    } catch (error) { setBackupMessage(error instanceof Error ? `Recovery could not be saved locally: ${error.message}` : "Recovery could not be saved locally. Check device storage and retry."); }
    finally { setRestoringBusy(false); }
  }

  const matchingNotes = notes.filter((note) => (noteFilter === "All materials" || note.category === noteFilter)
    && `${note.title} ${note.content} ${note.category}`.toLowerCase().includes(search.toLowerCase()));

  return <section className="study-tools-page">
    {gradeDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!gradeDeleteBusy && event.target === event.currentTarget) setGradeDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="grade-delete-title" aria-describedby="grade-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">GRADE RECORD REMOVAL</p><h2 id="grade-delete-title">Delete this grade?</h2><p id="grade-delete-description">Remove the <strong>{gradeDeleteRequest.course}</strong> record ({gradeDeleteRequest.letter}, {gradeDeleteRequest.credits} credit {gradeDeleteRequest.credits === 1 ? "unit" : "units"}) from your grade calculator? This cannot be undone.</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={gradeDeleteBusy} onClick={() => setGradeDeleteRequest(null)}>Keep grade</button><button type="button" className="attachment-delete-confirm" disabled={gradeDeleteBusy} onClick={() => void confirmGradeDelete()}>{gradeDeleteBusy ? "Deleting…" : "Delete grade"}</button></div></section></div>}
    {noteDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!noteDeleteBusy && event.target === event.currentTarget) setNoteDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="study-delete-title" aria-describedby="study-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">STUDY MATERIAL REMOVAL</p><h2 id="study-delete-title">Delete this study material?</h2><p id="study-delete-description"><strong>{noteDeleteRequest.title}</strong> will be deleted from this device and account. This action cannot be undone.</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={noteDeleteBusy} onClick={() => setNoteDeleteRequest(null)}>Keep material</button><button type="button" className="attachment-delete-confirm" disabled={noteDeleteBusy} onClick={() => void confirmNoteDelete()}>{noteDeleteBusy ? "Deleting…" : "Delete material"}</button></div></section></div>}
    {attachmentDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!attachmentDeleteBusy && event.target === event.currentTarget) setAttachmentDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="attachment-delete-title" aria-describedby="attachment-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">DOCUMENT REMOVAL</p><h2 id="attachment-delete-title">Delete this PDF or document?</h2><p id="attachment-delete-description"><strong>{attachmentDeleteRequest.attachment.name}</strong>{attachmentDeleteRequest.source === "note" ? " and its study material will be deleted from this device and account." : attachmentDeleteRequest.source === "draft" && editingNoteId ? " will be removed from this material when you save your changes." : attachmentDeleteRequest.source === "draft" ? " will be removed from this new material." : " will be deleted from this device and removed from the material."}</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={attachmentDeleteBusy} onClick={() => setAttachmentDeleteRequest(null)}>Keep document</button><button type="button" className="attachment-delete-confirm" disabled={attachmentDeleteBusy} onClick={() => void confirmAttachmentDelete()}>{attachmentDeleteBusy ? "Deleting…" : attachmentDeleteRequest.source === "note" ? "Delete material and file" : "Delete document"}</button></div></section></div>}
    {databaseError && <p className="study-feedback study-error" role="alert">{databaseError}</p>}
    {saveMessage && <p className="study-feedback" role="status">{saveMessage}</p>}
    {page === "Notes & Resources" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>Study materials</h2><p>Save notes, links, and readings in your private Firestore account.</p></div><span className="study-count-pill">{notes.length} saved</span></div>
      <form className="assignment-form study-form" onSubmit={(event) => void submitNote(event)}>
        <label>Title<input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Week 3 lecture notes" maxLength={120} required /></label>
        <label>Organize as<select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label className="study-wide">Notes or resource description<textarea value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} placeholder="Write a summary, key concepts, or study instructions…" rows={4} maxLength={15000} /></label>
        <label className="study-wide">Resource link (optional)<input type="url" value={form.resourceUrl} onChange={(event) => setForm((current) => ({ ...current, resourceUrl: event.target.value }))} placeholder="https://…" maxLength={1000} /></label>
        <div className="study-attachment-field study-wide"><span>Document attachment <small>PDF or document · up to 20 MB · saved on this device</small></span><label className="study-attachment-picker liquid-glass"><span aria-hidden="true">↥</span>{draftAttachment ? "Replace document" : "Upload PDF or document"}<input type="file" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,.pages,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={selectStudyAttachment} aria-label="Upload a PDF or document" /></label>{draftAttachment && <div className="study-attachment-preview liquid-glass"><span aria-hidden="true">▤</span><span className="study-attachment-name">{draftAttachment.name}<small>{(draftAttachment.size / (1024 * 1024)).toFixed(2)} MB · saved when you save this material</small></span><button type="button" className="study-action destructive" aria-label="Remove attached document" onClick={() => setAttachmentDeleteRequest({ source: "draft", attachment: draftAttachment })}>Remove</button></div>}</div>
        <div className="study-form-actions"><button className="primary-button" type="submit">{editingNoteId ? "Save changes" : "Save material"}</button>{editingNoteId && <button type="button" className="profile-cancel" onClick={() => { setEditingNoteId(null); setForm(emptyNote); setDraftAttachment(null); setAttachmentFile(null); }}>Cancel</button>}</div>
      </form>
      <div className="study-filter-row"><input aria-label="Search study materials" placeholder="Search materials…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Filter materials by category" value={noteFilter} onChange={(event) => setNoteFilter(event.target.value)}><option>All materials</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></div>
      <div className="study-note-list">{matchingNotes.map((note) => <article className="study-note liquid-glass" key={note.id} data-search-id={note.id}><div className="study-note-top"><span className="study-category">{note.category}</span><div><button type="button" className="study-action" onClick={() => { setForm({ title: note.title, category: note.category, content: note.content, resourceUrl: note.resourceUrl }); setDraftAttachment(note.attachment ?? null); setAttachmentFile(null); setEditingNoteId(note.id); }}>Edit</button><button type="button" className="study-action destructive" onClick={() => void removeNote(note.id)}>Delete</button></div></div><h3>{note.title}</h3>{note.content && <p>{note.content}</p>}{note.resourceUrl && <a href={note.resourceUrl} target="_blank" rel="noreferrer">Open resource ↗</a>}{note.attachment && <div className="study-attached-document-row"><button type="button" className="study-attached-document liquid-glass" onClick={() => void downloadStudyAttachment(note.attachment!)}><span aria-hidden="true">▤</span><span>{note.attachment.name}<small>Download · {(note.attachment.size / (1024 * 1024)).toFixed(2)} MB</small></span><span aria-hidden="true">↓</span></button><button type="button" className="study-action destructive study-attachment-delete" onClick={() => setAttachmentDeleteRequest({ source: "saved", noteId: note.id, attachment: note.attachment! })}>Delete document</button></div>}</article>)}{matchingNotes.length === 0 && <p className="empty-state">No materials match. Add a note or resource to start organizing your study library.</p>}</div>
    </section>}

    {page === "Grade Calculator" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>CGPA calculator</h2><p>Track course grades using a 5.0 scale (A=5, B=4, C=3, D=2, E=1, F=0).</p></div><span className="study-count-pill">{grades.length} courses</span></div>
      <div className="cgpa-summary liquid-glass"><div><span>Current CGPA</span><strong>{cgpa.value}</strong><small>out of 5.00</small></div><div><span>Credits counted</span><strong>{cgpa.credits}</strong><small>weighted credit units</small></div><div><span>Quality points</span><strong>{cgpa.points.toFixed(1)}</strong><small>grade points × credits</small></div></div>
      <form className="assignment-form study-form grade-form" onSubmit={(event) => void addGrade(event)}>
        <label>Course<input value={gradeDraft.course} onChange={(event) => setGradeDraft((current) => ({ ...current, course: event.target.value }))} placeholder="Course code or title" maxLength={120} required /></label>
        <label>Credit units<input type="number" min="0.5" max="50" step="0.5" value={gradeDraft.credits} onChange={(event) => setGradeDraft((current) => ({ ...current, credits: event.target.value }))} required /></label>
        <label>Grade<select value={gradeDraft.letter} onChange={(event) => setGradeDraft((current) => ({ ...current, letter: event.target.value }))}>{Object.entries(gradePoints).map(([letter, points]) => <option key={letter} value={letter}>{letter} · {points.toFixed(1)} points</option>)}</select></label>
        <label>Session / semester<input value={gradeDraft.term} onChange={(event) => setGradeDraft((current) => ({ ...current, term: event.target.value }))} placeholder="e.g. 2025/26 · First semester" maxLength={60} /></label>
        <button className="primary-button" type="submit">Add grade</button>
      </form>
      <div className="grade-record-list">{grades.map((grade) => <article className="grade-record" key={grade.id}><div><strong>{grade.course}</strong><span>{grade.term || "Session not specified"} · {grade.credits} credit {grade.credits === 1 ? "unit" : "units"}</span></div><span className="grade-badge">{grade.letter} · {(gradePoints[grade.letter] ?? 0).toFixed(1)}</span><button className="study-action destructive" type="button" aria-label={`Delete grade for ${grade.course}`} onClick={() => void removeGrade(grade.id)}>Delete</button></article>)}{grades.length === 0 && <p className="empty-state">Add completed or current courses to start tracking your CGPA.</p>}</div>
    </section>}

    {page === "Cloud Database" && <section className="panel study-panel">
      <div className="section-heading cloud-database-heading"><div><h2>Your cloud database</h2><p>CampusOS stores your academic records in Firebase Cloud Firestore.</p></div><span className={`cloud-status-pill ${!online ? "offline" : syncPending ? "syncing" : connected ? "connected" : "connecting"}`} role="status" aria-live="polite" aria-atomic="true">{!online ? "● Offline" : syncPending ? "● Sync pending" : connected ? "● Connected" : "● Connecting"}</span></div>
      <div className="database-explainer liquid-glass"><span className="database-icon">☁</span><div><h3>Private, account-scoped storage</h3><p>Records sync to your signed-in student account and load across devices. Firebase security rules restrict access to your own student record.</p><small>{cloudMessage || "Connected to your secure cloud account."}</small></div></div>
      <div className="database-count-grid">{Object.entries({ Courses: recordCounts.courses ?? 0, Assignments: recordCounts.assignments ?? 0, Schedules: recordCounts.schedules ?? 0, Exams: recordCounts.exams ?? 0, "Notes & resources": notes.length, "Grade records": grades.length }).map(([label, count]) => <article className="database-count liquid-glass" key={label}><span>{label}</span><strong>{count}</strong></article>)}</div>
      <p className="study-footnote">Study notes and grade records are saved with your student record in Firestore. Use Backup &amp; Recovery to download a portable copy of your academic information.</p>
    </section>}

    {page === "Backup & Recovery" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>Backup &amp; recovery</h2><p>Download a portable copy or restore a backup to your cloud account.</p></div><span className="study-count-pill">Your account only</span></div>
      <div className="backup-card liquid-glass"><div className="backup-symbol">⇩</div><div><h3>Download your academic data</h3><p>Get a readable, restorable PDF of your profile, courses, assignments, timetable, exams, notes, resources, and grades. Attached file contents remain on this device.</p><div className="backup-download-actions"><button className="primary-button" type="button" onClick={() => void downloadBackup()}>Download PDF</button></div><small className="backup-format-note">Use the original downloaded PDF in CampusOS recovery. Keep it private; it contains your academic information.</small></div></div>
      <div className="backup-card liquid-glass"><div className="backup-symbol recovery">↥</div><div><h3>Recover from a backup</h3><p>Choose a CampusOS PDF or JSON backup for this signed-in account. Restoring merges saved information; records with matching IDs are updated and other current records are kept.</p><label className="backup-file-label">Choose PDF or JSON backup<input type="file" accept="application/pdf,.pdf,application/json,.json" onChange={(event) => void readBackup(event)} /></label><small className="backup-format-note">Older report-only PDFs do not include recovery data. Download a new PDF backup from this version to make it restorable.</small>{restoreData && <div className="restore-confirm"><span>Ready to restore the backup for this account.</span><button className="primary-button" type="button" disabled={restoringBusy} onClick={() => setRestoring(true)}>{restoringBusy ? "Restoring…" : "Restore backup"}</button><button className="profile-cancel" type="button" onClick={() => { setRestoreData(null); setRestoring(false); }}>Cancel</button>{restoring && <div className="restore-confirm-warning"><p>Confirm recovery? Records with matching IDs will be updated. Other current records will remain.</p><button type="button" className="primary-button" disabled={restoringBusy} onClick={() => void restoreBackup()}>Confirm recovery</button><button type="button" className="profile-cancel" onClick={() => setRestoring(false)}>Go back</button></div>}</div>}</div></div>
      {backupMessage && <p className="study-feedback" role="status">{backupMessage}</p>}
      <p className="study-footnote">Backups contain private academic information. Keep downloaded files in a secure location and do not share them.</p>
    </section>}
  </section>;
}
