import { useEffect, useRef, useState } from "react";
import { ProfilePanel } from "./ProfilePanel";
import { AuthScreen, VerificationScreen } from "./AuthScreen";
import { EmailAuthProvider, browserSessionPersistence, onIdTokenChanged, reauthenticateWithCredential, setPersistence, signOut, updatePassword, updateProfile, type User } from "firebase/auth";
import { firebaseAuth, firebaseConfigured, firestoreDb } from "./firebase";
import { collection, doc, onSnapshot } from "firebase/firestore";
import {
  deleteAssignment as deleteAssignmentRecord,
  deleteCourse as deleteCourseRecord,
  deleteExam as deleteExamRecord,
  deleteSchedule as deleteScheduleRecord,
  ensureStudentRecord,
  renameCourse as renameCourseRecord,
  saveAssignment as saveAssignmentRecord,
  saveCourse as saveCourseRecord,
  saveExam as saveExamRecord,
  saveSchedule as saveScheduleRecord,
} from "./firestore";
import "./App.css";

type Course = {
  code: string;
  name: string;
  color: string;
};

type Schedule = {
  id: string;
  courseCode: string;
  day: string;
  start: string;
  end: string;
};

type Assignment = {
  id: string;
  title: string;
  question: string;
  course: string;
  due: string;
  completed: boolean;
};

type Exam = {
  id: string;
  title: string;
  courseCode: string;
  date: string;
  start: string;
  location: string;
};

type ThemeMode = "light" | "dark" | "system";

const initialAssignments: Assignment[] = [];
const initialCourses: Course[] = [];
const initialSchedules: Schedule[] = [];

function getStudentInitials(fullName: string) {
  const initials = fullName.trim().split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase());
  return initials.length ? initials.join(".") : "S";
}

function CampusOSWorkspace({ user, onSignOut }: { user: User; onSignOut: () => Promise<void> }) {
  const [activePage, setActivePage] = useState("Dashboard");
  const [studentName, setStudentName] = useState(user.displayName || user.email?.split("@")[0] || "Student");
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem("campusos-theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [reminderMessage, setReminderMessage] = useState("");
  const [assignments, setAssignments] = useState(initialAssignments);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState({ title: "", question: "", course: "", due: "" });
  const [courses, setCourses] = useState(initialCourses);
  const [recentCourseCodes, setRecentCourseCodes] = useState<string[]>([]);
  const [openCourseMenu, setOpenCourseMenu] = useState<string | null>(null);
  const [schedules, setSchedules] = useState(initialSchedules);
  const [exams, setExams] = useState<Exam[]>([]);
  const [examFormOpen, setExamFormOpen] = useState(false);
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [examDraft, setExamDraft] = useState({ title: "", courseCode: "", date: "", start: "09:00", location: "" });
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudMessage, setCloudMessage] = useState("Loading your saved student data…");
  const [scheduleCode, setScheduleCode] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleDay, setScheduleDay] = useState("Monday");
  const [scheduleStart, setScheduleStart] = useState("09:00");
  const [scheduleEnd, setScheduleEnd] = useState("10:00");
  const [editingCourseCode, setEditingCourseCode] = useState<string | null>(null);
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [newCourseCode, setNewCourseCode] = useState("");
  const [newCourseName, setNewCourseName] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [newCourse, setNewCourse] = useState("COS 102");
  const [newDue, setNewDue] = useState("");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updatePreference = () => setSystemPrefersDark(media.matches);
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("campusos-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !themeMenuRef.current?.contains(event.target)) setThemeMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    const db = firestoreDb;
    if (!db) {
      setCloudReady(true);
      setCloudMessage("Firebase is not configured; cloud records are unavailable.");
      return;
    }
    let cancelled = false;
    let readyParts = new Set<string>();
    let unsubscribers: Array<() => void> = [];
    const markReady = (key: string) => {
      readyParts.add(key);
      if (readyParts.size === 5) {
        setCloudReady(true);
        setCloudMessage("");
      }
    };
    const failed = () => {
      setCloudReady(true);
      setCloudMessage("CampusOS could not sync with Firestore. Changes will not be saved until the connection is restored.");
    };
    void ensureStudentRecord(user).then(() => {
      if (cancelled) return;
      unsubscribers = [
        onSnapshot(doc(db, "students", user.uid), (snapshot) => {
          const profileName = snapshot.data()?.profile?.fullName;
          if (typeof profileName === "string" && profileName.trim()) setStudentName(profileName);
          markReady("profile");
        }, failed),
        onSnapshot(collection(db, "students", user.uid, "courses"), (snapshot) => {
          const records = snapshot.docs.map((item) => ({ ...item.data(), code: item.id })) as Course[];
          setCourses(records);
          setRecentCourseCodes(snapshot.docs
            .slice()
            .sort((left, right) => (right.data().createdAt?.toMillis?.() ?? 0) - (left.data().createdAt?.toMillis?.() ?? 0))
            .map((item) => item.id)
            .slice(0, 6));
          markReady("courses");
        }, failed),
        onSnapshot(collection(db, "students", user.uid, "assignments"), (snapshot) => {
          setAssignments(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })) as Assignment[]);
          markReady("assignments");
        }, failed),
        onSnapshot(collection(db, "students", user.uid, "schedules"), (snapshot) => {
          setSchedules(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })) as Schedule[]);
          markReady("schedules");
        }, failed),
        onSnapshot(collection(db, "students", user.uid, "exams"), (snapshot) => {
          setExams(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })) as Exam[]);
          markReady("exams");
        }, failed),
      ];
    }).catch(failed);
    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [user.uid]);

  async function persistCloudRecord(save: () => Promise<void>) {
    try {
      await save();
      setCloudMessage("Saved to your secure student account.");
      return true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      if (code.endsWith("permission-denied")) {
        setCloudMessage("Firestore denied this save. Make sure your email is verified and the database rules are up to date.");
      } else if (code.endsWith("unavailable") || code.endsWith("deadline-exceeded")) {
        setCloudMessage("CampusOS could not reach Firestore. Your entry is still here; check your connection and save again.");
      } else {
        setCloudMessage("CampusOS could not save this entry. Please retry; if it continues, contact support.");
      }
      return false;
    }
  }

  function updateStudentName(name: string) {
    setStudentName(name);
    void updateProfile(user, { displayName: name }).catch(() => undefined);
  }

  async function changeStudentPassword(currentPassword: string, newPassword: string) {
    if (!user.email) throw new Error("This account has no email address.");
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
  }

  useEffect(() => {
    if (!openCourseMenu) return;
    const closeMenuOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".course-menu-wrap")) return;
      setOpenCourseMenu(null);
    };
    document.addEventListener("pointerdown", closeMenuOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeMenuOnOutsideClick);
  }, [openCourseMenu]);

  async function saveCourse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = newCourseCode.trim().toUpperCase();
    const name = newCourseName.trim();
    if (!code || !name || courses.some((course) => course.code === code && course.code !== editingCourseCode)) return;
    const course = { code, name, color: "leather" };
    const saved = await persistCloudRecord(() => editingCourseCode
      ? renameCourseRecord(user.uid, editingCourseCode, code, course)
      : saveCourseRecord(user.uid, code, course));
    if (!saved) return;
    setNewCourseCode("");
    setNewCourseName("");
    setEditingCourseCode(null);
    setShowCourseForm(false);
  }

  function beginEditCourse(code: string) {
    const course = courses.find((item) => item.code === code);
    if (!course) return;
    setEditingCourseCode(code);
    setNewCourseCode(course.code);
    setNewCourseName(course.name);
    setShowCourseForm(true);
    setActivePage("My Courses");
    setOpenCourseMenu(null);
  }

  async function saveSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = scheduleCode.trim().toUpperCase();
    const name = scheduleName.trim();
    if (!code || !name || scheduleStart >= scheduleEnd) return;
    const existing = courses.find((course) => course.code === code);
    const id = editingScheduleId ?? crypto.randomUUID();
    const saved = await persistCloudRecord(async () => {
      if (!existing) await saveCourseRecord(user.uid, code, { code, name, color: "leather" });
      await saveScheduleRecord(user.uid, id, { courseCode: code, day: scheduleDay, start: scheduleStart, end: scheduleEnd }, !editingScheduleId);
    });
    if (!saved) return;
    setScheduleFormOpen(false);
    setEditingScheduleId(null);
    setScheduleCode("");
    setScheduleName("");
  }

  function beginEditSchedule(schedule: Schedule) {
    const course = courses.find((item) => item.code === schedule.courseCode);
    setEditingScheduleId(schedule.id);
    setScheduleCode(schedule.courseCode);
    setScheduleName(course?.name ?? schedule.courseCode);
    setScheduleDay(schedule.day);
    setScheduleStart(schedule.start);
    setScheduleEnd(schedule.end);
    setScheduleFormOpen(true);
    setOpenCourseMenu(null);
  }

  async function removeCourse(code: string) {
    const saved = await persistCloudRecord(() => deleteCourseRecord(user.uid, code));
    if (saved) setOpenCourseMenu(null);
  }

  async function removeSchedule(id: string) {
    const saved = await persistCloudRecord(() => deleteScheduleRecord(user.uid, id));
    if (saved) setOpenCourseMenu(null);
  }

  async function saveExam(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = examDraft.title.trim();
    const courseCode = examDraft.courseCode.trim().toUpperCase();
    const date = examDraft.date;
    const start = examDraft.start;
    const location = examDraft.location.trim();
    if (!title || !courseCode || !date || !start || !location) return;
    const id = editingExamId ?? crypto.randomUUID();
    const saved = await persistCloudRecord(() => saveExamRecord(user.uid, id, { title, courseCode, date, start, location }, !editingExamId));
    if (saved) {
      setExamDraft({ title: "", courseCode: "", date: "", start: "09:00", location: "" });
      setEditingExamId(null);
      setExamFormOpen(false);
    }
  }

  function beginEditExam(exam: Exam) {
    setEditingExamId(exam.id);
    setExamDraft({ title: exam.title, courseCode: exam.courseCode, date: exam.date, start: exam.start, location: exam.location });
    setExamFormOpen(true);
    setOpenCourseMenu(null);
  }

  async function removeExam(id: string) {
    const saved = await persistCloudRecord(() => deleteExamRecord(user.uid, id));
    if (saved) setOpenCourseMenu(null);
  }

  async function removeAssignment(id: string) {
    const saved = await persistCloudRecord(() => deleteAssignmentRecord(user.uid, id));
    if (saved) setOpenCourseMenu(null);
  }

  async function toggleAssignment(id: string) {
    const assignment = assignments.find((item) => item.id === id);
    if (!assignment) return;
    await persistCloudRecord(() => saveAssignmentRecord(user.uid, id, { ...assignment, completed: !assignment.completed }, false));
  }

  function beginEditAssignment(assignment: Assignment) {
    setEditingAssignmentId(assignment.id);
    setAssignmentDraft({ title: assignment.title, question: assignment.question, course: assignment.course, due: assignment.due });
    setOpenCourseMenu(null);
  }

  async function saveAssignmentEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAssignmentId || !assignmentDraft.title.trim() || !assignmentDraft.question.trim() || !assignmentDraft.due.trim()) return;
    const assignment = { ...assignmentDraft, title: assignmentDraft.title.trim(), question: assignmentDraft.question.trim(), due: assignmentDraft.due.trim(), completed: assignments.find((item) => item.id === editingAssignmentId)?.completed ?? false };
    const saved = await persistCloudRecord(() => saveAssignmentRecord(user.uid, editingAssignmentId, assignment, false));
    if (saved) setEditingAssignmentId(null);
  }

  async function addAssignment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!newTitle.trim() || !newDue) return;

    const formattedDate = new Date(`${newDue}T12:00:00`).toLocaleDateString(
      "en-GB",
      { day: "numeric", month: "short" },
    );

    const id = crypto.randomUUID();
    const saved = await persistCloudRecord(() => saveAssignmentRecord(user.uid, id, {
      title: newTitle.trim(), question: newQuestion.trim(), course: newCourse, due: formattedDate, completed: false,
    }, true));
    if (!saved) return;

    setNewTitle("");
    setNewQuestion("");
    setNewDue("");
    setShowForm(false);
    setActivePage("Assignments");
  }

  const pendingCount = assignments.filter(
    (assignment) => !assignment.completed,
  ).length;

  const completedCount = assignments.filter(
    (assignment) => assignment.completed,
  ).length;

  async function sendPendingReminders() {
    const pending = assignments.filter((assignment) => !assignment.completed);
    if (!pending.length) {
      setReminderMessage("You are all caught up. There are no pending assignments.");
      return;
    }
    if (typeof Notification === "undefined") {
      setReminderMessage("This browser does not support desktop notifications. Your pending tasks are listed here.");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setReminderMessage("Notifications are blocked. Allow notifications in your browser to receive these reminders.");
      return;
    }
    try {
      pending.forEach((assignment) => new Notification(`Assignment reminder: ${assignment.title}`, {
        body: `${assignment.course} · Due ${assignment.due}`,
        icon: "/favicon.svg",
        tag: `assignment-${assignment.id}`,
        silent: !soundEnabled,
      }));
      setReminderMessage(`${pending.length} pending assignment ${pending.length === 1 ? "reminder was" : "reminders were"} sent.`);
    } catch {
      setReminderMessage("The browser could not send reminders. Check notification permissions and try again.");
    }
  }

  const navigation = [
    { name: "Home", page: "Dashboard", icon: "⌂" },
    { name: "My Courses", page: "My Courses", icon: "▤" },
    { name: "Assignments", page: "Assignments", icon: "✓" },
    { name: "Timetable", page: "Timetable", icon: "▦" },
  ];
  const activeTheme = themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;

  return (
    <div className="app-shell" data-theme={activeTheme}>
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <button className={`menu-trigger ${menuOpen ? "open" : ""}`} aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <span /><span /><span />
            </button>
            <a className="brand brand-top" href="#dashboard" onClick={() => { setActivePage("Dashboard"); setMenuOpen(false); }}>
              <span className="brand-icon">C</span>
              <span>Campus<span className="brand-light">OS</span></span>
            </a>
            <div className="breadcrumb">Workspace <span>/</span> <strong>{activePage}</strong></div>
          </div>
          <div className="topbar-right">
            <span className="today-label">{new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span>
            <div className="theme-control" ref={themeMenuRef}>
              <button className="theme-trigger" aria-label={`Appearance: ${themeMode}`} aria-expanded={themeMenuOpen} aria-haspopup="menu" title={`Appearance: ${themeMode}`} onClick={() => setThemeMenuOpen((open) => !open)}>
                {activeTheme === "dark" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>}
              </button>
              {themeMenuOpen && <div className="theme-menu liquid-glass" role="menu" aria-label="Choose appearance">
                <p className="theme-menu-heading">Appearance</p>
                {(["light", "dark", "system"] as ThemeMode[]).map((mode) => <button key={mode} className={`theme-option ${themeMode === mode ? "selected" : ""}`} role="menuitemradio" aria-checked={themeMode === mode} onClick={() => { setThemeMode(mode); setThemeMenuOpen(false); }}>
                  <span className="theme-option-icon">{mode === "light" ? "☼" : mode === "dark" ? "☾" : "◐"}</span><span>{mode === "system" ? "System default" : `${mode.charAt(0).toUpperCase()}${mode.slice(1)} mode`}</span>{themeMode === mode && <span className="theme-check">✓</span>}
                </button>)}
              </div>}
            </div>
            <div className="notification-controls">
              <button className={`notification-toggle ${soundEnabled ? "sound-on" : "sound-muted"}`} aria-label={soundEnabled ? "Mute reminder sounds" : "Turn reminder sounds on"} aria-pressed={!soundEnabled} title={soundEnabled ? "Sound on" : "Muted"} onClick={() => setSoundEnabled((enabled) => !enabled)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />{!soundEnabled && <path d="m4 4 16 16" />}</svg>
                {pendingCount > 0 && <span className="notification-count">{pendingCount}</span>}
              </button>
              <button className="notification-open-button" aria-label={notificationsOpen ? "Close assignment reminders" : "Open assignment reminders"} aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen((open) => !open); setReminderMessage(""); }}>⌄</button>
            </div>
            <button className="avatar small-avatar profile-avatar-button" aria-label={`Open ${studentName} profile`} aria-expanded={profileOpen} onClick={() => { setNotificationsOpen(false); setProfileOpen((open) => !open); }}>{getStudentInitials(studentName)}</button>
          </div>
        </header>
        {notificationsOpen && (
          <>
            <button className="reminder-backdrop" aria-label="Close assignment reminders" onClick={() => setNotificationsOpen(false)} />
            <section className="notification-panel liquid-glass" aria-label="Pending assignment reminders">
              <header className="notification-panel-heading"><div><p className="profile-kicker">CAMPUSOS REMINDERS</p><h2>Pending assignments</h2></div><span className="notification-panel-count">{pendingCount}</span></header>
              <div className="reminder-task-list">
                {assignments.filter((assignment) => !assignment.completed).map((assignment) => <article className="reminder-task" key={assignment.id}><strong>{assignment.title}</strong><span>{assignment.course} · Due {assignment.due}</span></article>)}
                {pendingCount === 0 && <p className="empty-state">You are all caught up.</p>}
              </div>
              {reminderMessage && <p className="reminder-message" role="status">{reminderMessage}</p>}
              <button className="primary-button reminder-send-button" onClick={() => void sendPendingReminders()} disabled={pendingCount === 0}>Send reminders now</button>
              <p className="reminder-sound-note">Reminder sound is {soundEnabled ? "on" : "muted"}. Toggle the bell to change it.</p>
            </section>
          </>
        )}
        {profileOpen && <ProfilePanel studentUid={user.uid} courses={courses} studentName={studentName} onNameChange={updateStudentName} onChangePassword={changeStudentPassword} onSignOut={onSignOut} onClose={() => setProfileOpen(false)} />}
        {menuOpen && (
          <>
            <button className="menu-backdrop" aria-label="Close navigation menu" onClick={() => setMenuOpen(false)} />
            <nav className="popup-navigation liquid-glass" aria-label="Workspace navigation">
              <p className="nav-label">WORKSPACE</p>
              {navigation.map((item) => (
                <button key={item.name} className={`nav-item ${activePage === item.page ? "active" : ""}`} onClick={() => { setActivePage(item.page); setShowForm(false); setMenuOpen(false); }}>
                  <span className="nav-icon">{item.icon}</span><span>{item.name}</span>
                  {item.name === "Assignments" && <span className="nav-count">{pendingCount}</span>}
                </button>
              ))}
            </nav>
          </>
        )}

        <div className="page-content">
          {(!cloudReady || cloudMessage) && <div className={`cloud-sync-notice ${cloudReady ? "" : "is-loading"}`} role="status">{cloudMessage || "Your records are synced with Firestore."}</div>}
          <section className="welcome-row">
            <div>
              <p className="eyebrow">YOUR ACADEMIC WORKSPACE</p>
              <h1>
                {activePage === "Dashboard" ? `Welcome back, ${studentName}!` : activePage}
                {activePage === "Dashboard" && <span className="wave">✦</span>}
              </h1>
              <p className="subtitle">
                Stay organised, keep learning, and make every day count.
              </p>
            </div>

            {activePage === "Assignments" && (
              <button
                className="primary-button"
                onClick={() => setShowForm(true)}
              >
                <span>＋</span> Add assignment
              </button>
            )}
          </section>

          {showForm && (
            <section className="panel form-panel">
              <div className="section-heading">
                <div>
                  <h2>New assignment</h2>
                  <p>Add an assignment to your academic planner.</p>
                </div>
                <button
                  className="close-button"
                  onClick={() => setShowForm(false)}
                  aria-label="Close form"
                >
                  ×
                </button>
              </div>

              <form className="assignment-form" onSubmit={addAssignment}>
                <label>
                  Assignment title
                  <input
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                    placeholder="e.g. Programming fundamentals"
                    required
                  />
                </label>

                <label>
                  Assignment question
                  <textarea
                    value={newQuestion}
                    onChange={(event) => setNewQuestion(event.target.value)}
                    placeholder="Enter the question or instructions for this assignment"
                    rows={4}
                    required
                  />
                </label>

                <label>
                  Course
                  <select
                    value={newCourse}
                    onChange={(event) => setNewCourse(event.target.value)}
                  >
                    {courses.map((course) => (
                      <option key={course.code} value={course.code}>
                        {course.code} — {course.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Due date
                  <input
                    type="date"
                    value={newDue}
                    onChange={(event) => setNewDue(event.target.value)}
                    required
                  />
                </label>

                <button className="primary-button" type="submit">
                  Save assignment
                </button>
              </form>
            </section>
          )}

          {activePage === "Dashboard" && (
            <>
              <section className="stats-grid">
                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon purple-bg">▤</span>
                    <span className="stat-caption">This semester</span>
                  </div>
                  <strong className="stat-number">{courses.length}</strong>
                  <span className="stat-description">Active courses</span>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon orange-bg">◷</span>
                    <span className="stat-caption">To keep track of</span>
                  </div>
                  <strong className="stat-number">{pendingCount}</strong>
                  <span className="stat-description">Pending assignments</span>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-icon green-bg">✓</span>
                    <span className="stat-caption">Great work</span>
                  </div>
                  <strong className="stat-number">{completedCount}</strong>
                  <span className="stat-description">
                    Completed assignments
                  </span>
                </article>
              </section>

              <section className="content-grid">
                <div className="panel assignments-panel">
                  <div className="section-heading">
                    <div>
                      <h2>Upcoming assignments</h2>
                      <p>Keep an eye on what needs your attention.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setActivePage("Assignments")}
                    >
                      View all →
                    </button>
                  </div>

                  <div className="assignment-list">
                    {assignments.slice(0, 4).map((assignment) => (
                      <div className="assignment-row" key={assignment.id}>
                        <button
                          className={`; checkbox; $; { assignment.completed ? 'checked' : '' } `}
                          onClick={() => toggleAssignment(assignment.id)}
                          aria-label={
                            assignment.completed
                              ? "Mark incomplete"
                              : "Mark complete"
                          }
                        >
                          {assignment.completed ? "✓" : ""}
                        </button>

                        <div className="assignment-info">
                          <strong
                            className={
                              assignment.completed ? "completed-title" : ""
                            }
                          >
                            {assignment.title}
                          </strong>
                          <span>{assignment.course}</span>
                          {assignment.question && <p className="assignment-question">{assignment.question}</p>}
                        </div>

                        <span
                          className={`; due - badge; $; { assignment.completed ? 'done-badge' : '' } `}
                        >
                          {assignment.completed ? "Completed" : assignment.due}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel courses-panel">
                  <div className="section-heading">
                    <div>
                      <h2>My courses</h2>
                      <p>Your semester at a glance.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setActivePage("My Courses")}
                    >
                      View all →
                    </button>
                  </div>

                  <div className="course-list">
                    {courses.map((course) => (
                      <div className="course-row" key={course.code}>
                        <div
                          className={`; course - icon; $; { course.color } `}
                        >
                          {course.code.slice(0, 3)}
                        </div>
                        <div className="course-info">
                          <strong>{course.name}</strong>
                          <span>{course.code}</span>
                        </div>
                        <span className="course-arrow">↗</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}

          {activePage === "My Courses" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Your courses</h2>
                  <p>Courses currently displayed in your workspace.</p>
                </div>
                <button className="primary-button" onClick={() => setShowCourseForm((shown) => !shown)}>
                  <span>＋</span> Add course
                </button>
              </div>
              {showCourseForm && (
                <form className="assignment-form course-form" onSubmit={saveCourse}>
                  <label>Course code<input value={newCourseCode} onChange={(event) => setNewCourseCode(event.target.value)} placeholder="e.g. BIO 104" required /></label>
                  <label>Course name<input value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="e.g. Introductory Biology" required /></label>
                  <button className="primary-button" type="submit">{editingCourseCode ? "Save changes" : "Save course"}</button>
                  {newCourseCode.trim() && courses.some((course) => course.code === newCourseCode.trim().toUpperCase() && course.code !== editingCourseCode) && <p className="form-error">A course with this code already exists.</p>}
                </form>
              )}
              <div className="course-grid">
                {courses.map((course) => (
                  <article className="course-card" key={course.code}>
                    <div className="course-card-top">
                      <div className={`course-icon ${course.color}`}>
                        {course.code.slice(0, 3)}
                      </div>
                      <div className="course-menu-wrap">
                        <button
                          className="course-menu-button"
                          aria-label={`Course options for ${course.code}`}
                          aria-expanded={openCourseMenu === course.code}
                          onClick={() => setOpenCourseMenu((current) => current === course.code ? null : course.code)}
                        >
                          ⋯
                        </button>
                        {openCourseMenu === course.code && (
                          <div className="course-menu">
                            <button onClick={() => beginEditCourse(course.code)}>Edit course</button>
                            <button onClick={() => void removeCourse(course.code)}>Delete course</button>
                          </div>
                        )}
                      </div>
                    </div>
                    <h3>{course.name}</h3>
                    <p>{course.code}</p>
                  </article>
                ))}
              </div>
              {recentCourseCodes.length > 0 && (
                <section className="recent-courses" aria-labelledby="recent-courses-title">
                  <div className="section-heading">
                    <div>
                      <h2 id="recent-courses-title">Recently registered courses</h2>
                      <p>Your newest courses, with the latest addition first.</p>
                    </div>
                  </div>
                  <div className="course-list">
                    {recentCourseCodes.map((code) => {
                      const course = courses.find((item) => item.code === code);
                      return course ? (
                        <div className="course-row" key={course.code}>
                          <div className={`course-icon ${course.color}`}>{course.code.slice(0, 3)}</div>
                          <div className="course-info"><strong>{course.name}</strong><span>{course.code}</span></div>
                          <span className="course-arrow">✓</span>
                        </div>
                      ) : null;
                    })}
                  </div>
                </section>
              )}
            </section>
          )}

          {activePage === "Assignments" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Assignment tracker</h2>
                  <p>Track your work and mark tasks complete.</p>
                </div>
              </div>
              <div className="assignment-list">
                {assignments.map((assignment) => editingAssignmentId === assignment.id ? (
                  <form className="assignment-form assignment-edit-form" key={assignment.id} onSubmit={saveAssignmentEdit}>
                    <label>Assignment title<input value={assignmentDraft.title} onChange={(event) => setAssignmentDraft((current) => ({ ...current, title: event.target.value }))} required /></label>
                    <label>Assignment question<textarea value={assignmentDraft.question} onChange={(event) => setAssignmentDraft((current) => ({ ...current, question: event.target.value }))} rows={4} required /></label>
                    <label>Course<select value={assignmentDraft.course} onChange={(event) => setAssignmentDraft((current) => ({ ...current, course: event.target.value }))} required>{courses.map((course) => <option key={course.code} value={course.code}>{course.code} — {course.name}</option>)}</select></label>
                    <label>Due date<input value={assignmentDraft.due} onChange={(event) => setAssignmentDraft((current) => ({ ...current, due: event.target.value }))} placeholder="e.g. 18 May" required /></label>
                    <div className="assignment-edit-actions"><button className="primary-button" type="submit">Save changes</button><button className="profile-cancel" type="button" onClick={() => setEditingAssignmentId(null)}>Cancel</button></div>
                  </form>
                ) : (
                  <div className="assignment-row" key={assignment.id}>
                    <button
                      className={`checkbox ${assignment.completed ? "checked" : ""}`}
                      onClick={() => toggleAssignment(assignment.id)}
                      aria-label={assignment.completed ? "Mark incomplete" : "Mark complete"}
                    >
                      {assignment.completed ? "✓" : ""}
                    </button>
                    <div className="assignment-info">
                      <strong className={assignment.completed ? "completed-title" : ""}>{assignment.title}</strong>
                      <span>{assignment.course}</span>
                      {assignment.question && <p className="assignment-question">{assignment.question}</p>}
                    </div>
                    <span className={`due-badge ${assignment.completed ? "done-badge" : ""}`}>
                      {assignment.completed ? "Completed" : assignment.due}
                    </span>
                    <div className="course-menu-wrap task-menu-wrap">
                      <button className="course-menu-button" aria-label={`Options for ${assignment.title}`} aria-expanded={openCourseMenu === `assignment-${assignment.id}`} onClick={() => setOpenCourseMenu((current) => current === `assignment-${assignment.id}` ? null : `assignment-${assignment.id}`)}>⋯</button>
                      {openCourseMenu === `assignment-${assignment.id}` && <div className="course-menu task-menu"><button type="button" onClick={() => beginEditAssignment(assignment)}>Edit task</button><button type="button" onClick={() => void removeAssignment(assignment.id)}>Delete task</button></div>}
                    </div>
                  </div>
                ))}
                {assignments.length === 0 && (
                  <p className="empty-state">
                    No assignments yet. Add your first assignment to get
                    started.
                  </p>
                )}
              </div>
              <div className="assignment-courses">
                <div className="section-heading">
                  <div><h2>Courses</h2><p>Manage courses used by your assignments.</p></div>
                </div>
                <div className="course-list">
                  {courses.map((course) => (
                    <div className="course-row" key={course.code}>
                      <div className={`course-icon ${course.color}`}>{course.code.slice(0, 3)}</div>
                      <div className="course-info"><strong>{course.name}</strong><span>{course.code}</span></div>
                      <div className="course-menu-wrap">
                        <button className="course-menu-button" aria-label={`Course options for ${course.code}`} aria-expanded={openCourseMenu === course.code} onClick={() => setOpenCourseMenu((current) => current === course.code ? null : course.code)}>⋯</button>
                        {openCourseMenu === course.code && <div className="course-menu"><button onClick={() => beginEditCourse(course.code)}>Edit course</button><button onClick={() => void removeCourse(course.code)}>Delete course</button></div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {activePage === "Timetable" && (
            <>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Your weekly timetable</h2>
                  <p>Add courses with their weekly meeting day and time.</p>
                </div>
                <button className="primary-button" onClick={() => { setEditingScheduleId(null); setScheduleCode(""); setScheduleName(""); setScheduleDay("Monday"); setScheduleStart("09:00"); setScheduleEnd("10:00"); setScheduleFormOpen((open) => !open); }}>
                  <span>＋</span> Add course & schedule
                </button>
              </div>
              {scheduleFormOpen && (
                <form className="assignment-form schedule-form" onSubmit={saveSchedule}>
                  <label>Course code<input value={scheduleCode} onChange={(event) => setScheduleCode(event.target.value)} placeholder="e.g. BIO 104" required /></label>
                  <label>Course name<input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="e.g. Introductory Biology" required /></label>
                  <label>Day<select value={scheduleDay} onChange={(event) => setScheduleDay(event.target.value)}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => <option key={day}>{day}</option>)}</select></label>
                  <div className="schedule-time-fields">
                    <label>Start time<input type="time" value={scheduleStart} onChange={(event) => setScheduleStart(event.target.value)} required /></label>
                    <label>End time<input type="time" value={scheduleEnd} onChange={(event) => setScheduleEnd(event.target.value)} required /></label>
                  </div>
                  {scheduleStart >= scheduleEnd && <p className="form-error">End time must be later than start time.</p>}
                  <button className="primary-button" type="submit">{editingScheduleId ? "Save schedule" : "Add to timetable"}</button>
                </form>
              )}
              <div className="timetable-list">
                {schedules.map((schedule) => {
                  const course = courses.find((item) => item.code === schedule.courseCode);
                  return (
                    <div className="lecture-row" key={schedule.id}>
                      <span className="lecture-day">{schedule.day.slice(0, 3).toUpperCase()}</span>
                      <div className="lecture-info">
                        <strong>{course?.name ?? schedule.courseCode}</strong>
                        <span>{schedule.start} – {schedule.end} · {schedule.courseCode}</span>
                      </div>
                      <div className="course-menu-wrap">
                        <button className="course-menu-button" aria-label={`Options for ${schedule.courseCode} schedule`} aria-expanded={openCourseMenu === `schedule-${schedule.id}`} onClick={() => setOpenCourseMenu((current) => current === `schedule-${schedule.id}` ? null : `schedule-${schedule.id}`)}>⋯</button>
                        {openCourseMenu === `schedule-${schedule.id}` && <div className="course-menu"><button onClick={() => beginEditSchedule(schedule)}>Edit schedule</button><button onClick={() => void removeSchedule(schedule.id)}>Delete schedule</button><button onClick={() => beginEditCourse(schedule.courseCode)}>Edit course</button><button onClick={() => void removeCourse(schedule.courseCode)}>Delete course</button></div>}
                      </div>
                    </div>
                  );
                })}
                {schedules.length === 0 && <p className="empty-state">No scheduled courses yet. Add one to get started.</p>}
              </div>
            </section>
            <section className="panel exam-panel">
              <div className="section-heading">
                <div>
                  <h2>Exam timetable</h2>
                  <p>Keep upcoming examinations, times, and venues in one place.</p>
                </div>
                <button className="primary-button" onClick={() => { setEditingExamId(null); setExamDraft({ title: "", courseCode: "", date: "", start: "09:00", location: "" }); setExamFormOpen((open) => !open); }}>
                  <span>＋</span> Add exam
                </button>
              </div>
              {examFormOpen && <form className="assignment-form exam-form" onSubmit={saveExam}>
                <label>Exam title<input value={examDraft.title} onChange={(event) => setExamDraft((draft) => ({ ...draft, title: event.target.value }))} placeholder="e.g. Final examination" maxLength={160} required /></label>
                <label>Course code<input value={examDraft.courseCode} onChange={(event) => setExamDraft((draft) => ({ ...draft, courseCode: event.target.value }))} placeholder="e.g. COS 102" maxLength={32} required /></label>
                <label>Exam date<input type="date" value={examDraft.date} onChange={(event) => setExamDraft((draft) => ({ ...draft, date: event.target.value }))} required /></label>
                <label>Start time<input type="time" value={examDraft.start} onChange={(event) => setExamDraft((draft) => ({ ...draft, start: event.target.value }))} required /></label>
                <label>Venue<input value={examDraft.location} onChange={(event) => setExamDraft((draft) => ({ ...draft, location: event.target.value }))} placeholder="e.g. Main auditorium" maxLength={160} required /></label>
                <div className="exam-form-actions"><button className="primary-button" type="submit">{editingExamId ? "Save exam" : "Add to exam timetable"}</button>{editingExamId && <button className="profile-cancel" type="button" onClick={() => { setEditingExamId(null); setExamFormOpen(false); }}>Cancel</button>}</div>
              </form>}
              <div className="exam-list">
                {[...exams].sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`)).map((exam) => {
                  const examDate = new Date(`${exam.date}T00:00:00`);
                  const daysAway = Math.ceil((examDate.getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
                  const dateLabel = Number.isNaN(examDate.getTime()) ? exam.date : examDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
                  return <article className="exam-row" key={exam.id}>
                    <div className="exam-date-tile"><strong>{Number.isNaN(examDate.getTime()) ? "—" : examDate.getDate()}</strong><span>{Number.isNaN(examDate.getTime()) ? "" : examDate.toLocaleDateString("en-GB", { month: "short" })}</span></div>
                    <div className="exam-info"><strong>{exam.title}</strong><span>{exam.courseCode} · {dateLabel} · {exam.start}</span><span className="exam-location">{exam.location}</span></div>
                    <span className={`exam-countdown ${daysAway < 0 ? "exam-past" : ""}`}>{daysAway < 0 ? "Past" : daysAway === 0 ? "Today" : daysAway === 1 ? "Tomorrow" : `${daysAway} days`}</span>
                    <div className="course-menu-wrap"><button className="course-menu-button" aria-label={`Options for ${exam.title}`} aria-expanded={openCourseMenu === `exam-${exam.id}`} onClick={() => setOpenCourseMenu((current) => current === `exam-${exam.id}` ? null : `exam-${exam.id}`)}>⋯</button>
                      {openCourseMenu === `exam-${exam.id}` && <div className="course-menu"><button type="button" onClick={() => beginEditExam(exam)}>Edit exam</button><button type="button" onClick={() => void removeExam(exam.id)}>Delete exam</button></div>}
                    </div>
                  </article>;
                })}
                {exams.length === 0 && <p className="empty-state">No exams added yet. Add an upcoming examination to keep its date and venue handy.</p>}
              </div>
            </section>
            </>
          )}

          <footer className="footer">
            <span>CampusOS</span>
            <span>Built for your academic journey.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!firebaseConfigured);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    const auth = firebaseAuth;
    if (!auth) {
      setAuthReady(true);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void setPersistence(auth, browserSessionPersistence).then(() => {
      if (cancelled) return;
      unsubscribe = onIdTokenChanged(auth, (currentUser) => {
        setUser(currentUser);
        setAuthReady(true);
      }, () => {
        setAuthError("We could not check your sign-in session. Please try again.");
        setAuthReady(true);
      });
    }).catch(() => {
      setAuthError("We could not start a secure sign-in session. Check the Firebase configuration.");
      setAuthReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  if (!authReady) return <main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Checking your secure session…</section></main>;
  if (authError) return <AuthScreen initialError={authError} />;
  if (!user) return <AuthScreen />;
  if (!user.emailVerified) return <VerificationScreen user={user} />;
  return <CampusOSWorkspace key={user.uid} user={user} onSignOut={() => firebaseAuth ? signOut(firebaseAuth) : Promise.resolve()} />;
}

export default App;
