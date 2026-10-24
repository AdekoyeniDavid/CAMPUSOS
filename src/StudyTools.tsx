import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { firebaseConfigured } from "./firebase";
import { createRecordId } from "./browser";
import { cacheStudentDocument, saveStudyRecord, watchStudentDocument } from "./firestore";
import { listLocalRecords, pendingWriteCount, saveLocalRecord, syncPendingWrites, watchLocalRecords } from "./offlineStore";

type Note = { id: string; title: string; category: string; content: string; resourceUrl: string };
type Grade = { id: string; course: string; credits: number; letter: string; term: string };
type BackupCollection = "courses" | "assignments" | "schedules" | "exams";
type Backup = { app: "CampusOS"; version: 1; studentUid: string; createdAt: string; student: Record<string, unknown>; collections: Record<BackupCollection, Array<{ id: string; data: Record<string, unknown> }>> };

const categories = ["Lecture notes", "Reading", "Research", "Resource link", "Other"];
const gradePoints: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
const studyCollectionNames: BackupCollection[] = ["courses", "assignments", "schedules", "exams"];
const emptyNote = { title: "", category: categories[0], content: "", resourceUrl: "" };

function validateBackup(value: unknown, uid: string): value is Backup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Backup>;
  if (candidate.app !== "CampusOS" || candidate.version !== 1 || candidate.studentUid !== uid || !candidate.student || !candidate.collections) return false;
  if (typeof candidate.student !== "object" || Array.isArray(candidate.student)) return false;
  return studyCollectionNames.every((name) => Array.isArray(candidate.collections?.[name])
    && candidate.collections[name].length <= 1000
    && candidate.collections[name].every((item) => item && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 150 && !item.id.includes("/") && item.data && typeof item.data === "object" && !Array.isArray(item.data)));
}

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
    const remoteUnsubscribe = watchStudentDocument(studentUid, (student, fromCache) => {
      if (student) void cacheStudentDocument(studentUid, student, !fromCache);
    }, () => setDatabaseError("Cloud sync is unavailable. Study records stay on this device and will retry automatically."));
    return () => { localUnsubscribe(); remoteUnsubscribe(); };
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
    const nextNote: Note = { id: editingNoteId ?? createRecordId(), ...form };
    try {
      const next = editingNoteId ? notes.map((item) => item.id === editingNoteId ? nextNote : item) : [nextNote, ...notes];
      await saveNotes(next);
      setNotes(next);
      setForm(emptyNote); setEditingNoteId(null);
      setDatabaseError("");
    } catch (error) { setStudySavePending(false); setDatabaseError(error instanceof Error ? error.message : "The note could not be saved locally. Check available device storage and try again."); }
  }

  async function removeNote(id: string) {
    if (!window.confirm("Delete this study material? This cannot be undone.")) return;
    try { const next = notes.filter((item) => item.id !== id); await saveNotes(next); setNotes(next); setDatabaseError(""); } catch { setStudySavePending(false); setDatabaseError("The study material could not be saved locally. Check available device storage and try again."); }
  }

  async function addGrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const grade: Grade = { id: createRecordId(), course: gradeDraft.course.trim(), credits: Number(gradeDraft.credits), letter: gradeDraft.letter, term: gradeDraft.term.trim() };
    if (!grade.course || !Number.isFinite(grade.credits) || grade.credits <= 0 || grade.credits > 50) return;
    try { const next = [grade, ...grades]; await saveGrades(next); setGrades(next); setGradeDraft({ course: "", credits: "", letter: "A", term: "" }); setDatabaseError(""); }
    catch { setStudySavePending(false); setDatabaseError("The grade record could not be saved locally. Check available device storage and try again."); }
  }

  async function removeGrade(id: string) {
    try { const next = grades.filter((item) => item.id !== id); await saveGrades(next); setGrades(next); setDatabaseError(""); } catch { setStudySavePending(false); setDatabaseError("The grade record could not be saved locally. Check available device storage and try again."); }
  }

  async function downloadBackup() {
    setBackupMessage("Preparing a backup from this device…");
    try {
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
      const backup: Backup = {
        app: "CampusOS", version: 1, studentUid, createdAt: new Date().toISOString(),
        student: Object.fromEntries(Object.entries(student).filter(([key]) => key !== "authorizedStaffUids" && key !== "createdAt")),
        collections: Object.fromEntries(studyCollectionNames.map((name, index) => [
          name,
          collections[index].map(({ id, ...data }) => ({ id, data })),
        ])) as Backup["collections"],
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = `campusos-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
      setBackupMessage("Backup downloaded. Store the file somewhere safe; it contains private academic data.");
    } catch (error) { setBackupMessage(error instanceof Error ? error.message : "The backup could not be created. Check your connection and try again."); }
  }

  async function readBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBackupMessage(""); setRestoreData(null);
    if (file.size > 10_000_000) { setBackupMessage("This backup is larger than 10 MB and cannot be restored here."); return; }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!validateBackup(parsed, studentUid)) throw new Error("Choose a valid CampusOS backup made for this signed-in account.");
      setRestoreData(parsed); setBackupMessage(`Backup ready: ${Object.values(parsed.collections).reduce((sum, records) => sum + records.length, 0)} saved records can be restored.`);
    } catch (error) { setBackupMessage(error instanceof Error ? error.message : "This backup file could not be read."); }
  }

  async function restoreBackup() {
    if (!restoreData) return;
    setRestoringBusy(true); setBackupMessage("");
    try {
      const studentFields = ["profile", "institution", "personal", "contact", "academic", "enrolment", "courses", "progress"];
      for (const field of studentFields) {
        const value = restoreData.student[field];
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const sectionData = { ...(value as Record<string, unknown>) };
        if (field === "progress") {
          delete sectionData.studyNotes;
          delete sectionData.gradeRecords;
        }
        await saveLocalRecord(studentUid, "studentSections", field, sectionData);
      }
      const progress = restoreData.student.progress && typeof restoreData.student.progress === "object"
        ? restoreData.student.progress as Record<string, unknown>
        : {};
      for (const field of ["studyNotes", "gradeRecords"] as const) {
        if (Array.isArray(progress[field])) await saveLocalRecord(studentUid, "studentSections", field, { value: progress[field] });
      }
      for (const name of studyCollectionNames) {
        for (const { id, data } of restoreData.collections[name]) {
          await saveLocalRecord(studentUid, name, id, { ...data, updatedAt: Date.now() });
        }
      }
      if (navigator.onLine) void syncPendingWrites(studentUid);
      setRestoreData(null); setRestoring(false); setBackupMessage("Recovery saved on this device. Existing records were kept, and changes will sync to Firestore when connected.");
    } catch (error) { setBackupMessage(error instanceof Error ? `Recovery could not be saved locally: ${error.message}` : "Recovery could not be saved locally. Check device storage and retry."); }
    finally { setRestoringBusy(false); }
  }

  const matchingNotes = notes.filter((note) => (noteFilter === "All materials" || note.category === noteFilter)
    && `${note.title} ${note.content} ${note.category}`.toLowerCase().includes(search.toLowerCase()));

  return <section className="study-tools-page">
    {databaseError && <p className="study-feedback study-error" role="alert">{databaseError}</p>}
    {saveMessage && <p className="study-feedback" role="status">{saveMessage}</p>}
    {page === "Notes & Resources" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>Study materials</h2><p>Save notes, links, and readings in your private Firestore account.</p></div><span className="study-count-pill">{notes.length} saved</span></div>
      <form className="assignment-form study-form" onSubmit={(event) => void submitNote(event)}>
        <label>Title<input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Week 3 lecture notes" maxLength={120} required /></label>
        <label>Organize as<select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label className="study-wide">Notes or resource description<textarea value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} placeholder="Write a summary, key concepts, or study instructions…" rows={4} maxLength={15000} /></label>
        <label className="study-wide">Resource link (optional)<input type="url" value={form.resourceUrl} onChange={(event) => setForm((current) => ({ ...current, resourceUrl: event.target.value }))} placeholder="https://…" maxLength={1000} /></label>
        <div className="study-form-actions"><button className="primary-button" type="submit">{editingNoteId ? "Save changes" : "Save material"}</button>{editingNoteId && <button type="button" className="profile-cancel" onClick={() => { setEditingNoteId(null); setForm(emptyNote); }}>Cancel</button>}</div>
      </form>
      <div className="study-filter-row"><input aria-label="Search study materials" placeholder="Search materials…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Filter materials by category" value={noteFilter} onChange={(event) => setNoteFilter(event.target.value)}><option>All materials</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></div>
      <div className="study-note-list">{matchingNotes.map((note) => <article className="study-note liquid-glass" key={note.id} data-search-id={note.id}><div className="study-note-top"><span className="study-category">{note.category}</span><div><button type="button" className="study-action" onClick={() => { setForm({ title: note.title, category: note.category, content: note.content, resourceUrl: note.resourceUrl }); setEditingNoteId(note.id); }}>Edit</button><button type="button" className="study-action destructive" onClick={() => void removeNote(note.id)}>Delete</button></div></div><h3>{note.title}</h3>{note.content && <p>{note.content}</p>}{note.resourceUrl && <a href={note.resourceUrl} target="_blank" rel="noreferrer">Open resource ↗</a>}</article>)}{matchingNotes.length === 0 && <p className="empty-state">No materials match. Add a note or resource to start organizing your study library.</p>}</div>
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
      <div className="section-heading"><div><h2>Your cloud database</h2><p>CampusOS stores your academic records in Firebase Cloud Firestore.</p></div><span className={`cloud-status-pill ${connected && !syncPending ? "connected" : "disconnected"}`}>{!online ? "● Offline" : syncPending ? "● Sync pending" : connected ? "● Connected" : "● Connecting"}</span></div>
      <div className="database-explainer liquid-glass"><span className="database-icon">☁</span><div><h3>Private, account-scoped storage</h3><p>Records sync to your signed-in student account and load across devices. Firebase security rules restrict access to your own student record.</p><small>{cloudMessage || "Connected to your secure cloud account."}</small></div></div>
      <div className="database-count-grid">{Object.entries({ Courses: recordCounts.courses ?? 0, Assignments: recordCounts.assignments ?? 0, Schedules: recordCounts.schedules ?? 0, Exams: recordCounts.exams ?? 0, "Notes & resources": notes.length, "Grade records": grades.length }).map(([label, count]) => <article className="database-count liquid-glass" key={label}><span>{label}</span><strong>{count}</strong></article>)}</div>
      <p className="study-footnote">Study notes and grade records are saved with your student record in Firestore. Use Backup &amp; Recovery to download a portable copy of your academic information.</p>
    </section>}

    {page === "Backup & Recovery" && <section className="panel study-panel">
      <div className="section-heading"><div><h2>Backup &amp; recovery</h2><p>Download a portable copy or restore a backup to your cloud account.</p></div><span className="study-count-pill">Your account only</span></div>
      <div className="backup-card liquid-glass"><div className="backup-symbol">⇩</div><div><h3>Download your academic backup</h3><p>Includes your profile, courses, assignments, timetable, exams, notes, resources, and grades.</p><button className="primary-button" type="button" onClick={() => void downloadBackup()}>Download backup</button></div></div>
      <div className="backup-card liquid-glass"><div className="backup-symbol recovery">↥</div><div><h3>Recover from a backup</h3><p>Choose a CampusOS backup for this signed-in account. Restoring merges saved information; it does not remove current records.</p><label className="backup-file-label">Choose backup file<input type="file" accept="application/json,.json" onChange={(event) => void readBackup(event)} /></label>{restoreData && <div className="restore-confirm"><span>Ready to restore the backup for this account.</span><button className="primary-button" type="button" disabled={restoringBusy} onClick={() => setRestoring(true)}>{restoringBusy ? "Restoring…" : "Restore backup"}</button><button className="profile-cancel" type="button" onClick={() => { setRestoreData(null); setRestoring(false); }}>Cancel</button>{restoring && <div className="restore-confirm-warning"><p>Confirm recovery? Saved profile and academic records will be merged from this file.</p><button type="button" className="primary-button" disabled={restoringBusy} onClick={() => void restoreBackup()}>Confirm recovery</button><button type="button" className="profile-cancel" onClick={() => setRestoring(false)}>Go back</button></div>}</div>}</div></div>
      {backupMessage && <p className="study-feedback" role="status">{backupMessage}</p>}
      <p className="study-footnote">Backups contain private academic information. Keep downloaded files in a secure location and do not share them.</p>
    </section>}
  </section>;
}
