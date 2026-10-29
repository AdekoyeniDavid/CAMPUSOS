import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EmailAuthProvider, getIdToken, onIdTokenChanged, reauthenticateWithCredential, signOut, updatePassword, updateProfile, type User } from "firebase/auth";
import { firebaseAuth, firebaseConfigured } from "./firebase";
import {
  deleteAssignment as deleteAssignmentRecord,
  deleteCourse as deleteCourseRecord,
  deleteExam as deleteExamRecord,
  deleteSchedule as deleteScheduleRecord,
  cacheStudentDocument,
  ensureStudentRecord,
  renameCourse as renameCourseRecord,
  saveAssignment as saveAssignmentRecord,
  saveCourse as saveCourseRecord,
  saveExam as saveExamRecord,
  saveSchedule as saveScheduleRecord,
  removeAssignmentReminderPreference,
  saveAssignmentReminderPreference,
  removeCourseTimetableReminderPreferences,
  removeTimetableReminderPreference,
  saveTimetableReminderPreference,
  revokeOtherSessions as revokeOtherSessionsRecord,
  watchSessionRevocation,
  watchStudentCollection,
  watchStudentDocument,
  watchTimetableReminderPreferences,
  watchAssignmentReminderPreferences,
} from "./firestore";
import { pendingWriteCount, replaceWithRemoteRecords, syncPendingWrites, watchLocalRecords } from "./offlineStore";
import "./App.css";
import { createRecordId, readStoredValue, writeStoredValue } from "./browser";
import { normalizeCourseRecords } from "./courseRecords";

const ProfilePanel = lazy(() => import("./ProfilePanel").then((module) => ({ default: module.ProfilePanel })));
const StudyTools = lazy(() => import("./StudyTools").then((module) => ({ default: module.StudyTools })));
const AuthScreen = lazy(() => import("./AuthScreen").then((module) => ({ default: module.AuthScreen })));
const VerificationScreen = lazy(() => import("./AuthScreen").then((module) => ({ default: module.VerificationScreen })));
const EmailActionScreen = lazy(() => import("./AuthScreen").then((module) => ({ default: module.EmailActionScreen })));

type Course = {
  code: string;
  name: string;
  color: string;
  creditUnits?: number;
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
  description?: string;
  course: string;
  due: string;
  dueDate?: string;
  completed: boolean;
  studentId?: string;
  createdAt?: number | string | { seconds?: number };
  updatedAt?: number | string | { seconds?: number };
};

type Exam = {
  id: string;
  title: string;
  courseCode: string;
  date: string;
  start: string;
  location: string;
};
type SavedTimetableReminder = { sourceType: "weekly" | "exam"; sourceId: string; leadMinutes: number };
type SavedAssignmentReminder = { assignmentId: string; dueDate: string; dueTime: string; leadMinutes: number };

type StudyMaterial = { id: string; title: string; category: string; content: string; resourceUrl: string };
type QuickSearchResult = { id: string; title: string; detail: string; category: string; page: string; searchable: string };

type ThemeMode = "light" | "dark" | "system";

function isInstalledHomeScreenApp() {
  const standaloneDisplay = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneDisplay || iosStandalone;
}

const initialAssignments: Assignment[] = [];
const initialCourses: Course[] = [];
const initialSchedules: Schedule[] = [];

function getStudentInitials(fullName: string) {
  const initials = fullName.trim().split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase());
  return initials.length ? initials.join(".") : "S";
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function formatAssignmentDate(value: Assignment["createdAt"]) {
  if (value === undefined || value === null || value === "") return "Not provided";
  let milliseconds: number;
  if (typeof value === "number") milliseconds = value;
  else if (typeof value === "string") milliseconds = new Date(value).getTime();
  else if (typeof value.seconds === "number") milliseconds = value.seconds * 1000;
  else return "Not provided";
  if (!Number.isFinite(milliseconds)) return "Not provided";
  return new Date(milliseconds).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatAssignmentDueDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : value;
}

function isStudyMaterial(value: unknown): value is StudyMaterial {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string"
    && "title" in value && typeof value.title === "string";
}

function CampusOSWorkspace({ user, onSignOut }: { user: User; onSignOut: () => Promise<void> }) {
  const [activePage, setActivePage] = useState("Dashboard");
  const [studentName, setStudentName] = useState(user.displayName || user.email?.split("@")[0] || "Student");
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (isInstalledHomeScreenApp()) return "system";
    const saved = readStoredValue("campusos-theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [quickSearchQuery, setQuickSearchQuery] = useState("");
  const [searchMaterials, setSearchMaterials] = useState<StudyMaterial[]>([]);
  const [searchTargetId, setSearchTargetId] = useState<string | null>(null);
  const [studentMatriculationNo, setStudentMatriculationNo] = useState("Not provided");
  const quickSearchRef = useRef<HTMLDivElement>(null);
  const quickSearchInputRef = useRef<HTMLInputElement>(null);
  const quickSearchPopoverRef = useRef<HTMLElement>(null);
  const reminderCancelRef = useRef<HTMLButtonElement>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [reminderMessage, setReminderMessage] = useState("");
  const [reminderConfirmation, setReminderConfirmation] = useState<"desktop" | "email" | null>(null);
  const [emailReminderSending, setEmailReminderSending] = useState(false);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState({ title: "", question: "", course: "", due: "" });
  const [courses, setCourses] = useState(initialCourses);
  const [recentCourseCodes, setRecentCourseCodes] = useState<string[]>([]);
  const [openCourseMenu, setOpenCourseMenu] = useState<string | null>(null);
  const [assignmentMenuPosition, setAssignmentMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [courseDeleteRequest, setCourseDeleteRequest] = useState<Course | null>(null);
  const [courseDeleteBusy, setCourseDeleteBusy] = useState(false);
  const [assignmentDeleteRequest, setAssignmentDeleteRequest] = useState<Assignment | null>(null);
  const [assignmentDeleteBusy, setAssignmentDeleteBusy] = useState(false);
  const [assignmentReminderRequest, setAssignmentReminderRequest] = useState<Assignment | null>(null);
  const [assignmentReminderRemovalRequest, setAssignmentReminderRemovalRequest] = useState<Assignment | null>(null);
  const [assignmentReminderRemovalBusy, setAssignmentReminderRemovalBusy] = useState(false);
  const [assignmentReminderDate, setAssignmentReminderDate] = useState("");
  const [assignmentReminderTime, setAssignmentReminderTime] = useState("09:00");
  const [assignmentReminderLead, setAssignmentReminderLead] = useState(60);
  const [assignmentReminderBusy, setAssignmentReminderBusy] = useState(false);
  const [assignmentReminders, setAssignmentReminders] = useState<SavedAssignmentReminder[]>([]);
  const [timetableDeleteRequest, setTimetableDeleteRequest] = useState<{ type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam } | null>(null);
  const [timetableDeleteBusy, setTimetableDeleteBusy] = useState(false);
  const [timetableReminderRequest, setTimetableReminderRequest] = useState<{ type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam } | null>(null);
  const [timetableReminderRemovalRequest, setTimetableReminderRemovalRequest] = useState<{ type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam } | null>(null);
  const [timetableReminderLead, setTimetableReminderLead] = useState(15);
  const [timetableReminderBusy, setTimetableReminderBusy] = useState(false);
  const [timetableReminderRemovalBusy, setTimetableReminderRemovalBusy] = useState(false);
  const [timetableReminders, setTimetableReminders] = useState<SavedTimetableReminder[]>([]);
  const [timetableQueueVersion, setTimetableQueueVersion] = useState(0);
  const [schedules, setSchedules] = useState(initialSchedules);
  const [exams, setExams] = useState<Exam[]>([]);
  const [examFormOpen, setExamFormOpen] = useState(false);
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [examDraft, setExamDraft] = useState({ title: "", courseCode: "", date: "", start: "09:00", location: "" });
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudMessage, setCloudMessage] = useState("Loading your saved student data from this device…");
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [queuedWriteCount, setPendingCount] = useState(0);
  const [syncFailure, setSyncFailure] = useState("");
  const [scheduleCode, setScheduleCode] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleDay, setScheduleDay] = useState("Monday");
  const [scheduleStart, setScheduleStart] = useState("09:00");
  const [scheduleEnd, setScheduleEnd] = useState("10:00");
  const [editingCourseCode, setEditingCourseCode] = useState<string | null>(null);
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [newCourseCode, setNewCourseCode] = useState("");
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseCreditUnits, setNewCourseCreditUnits] = useState(1);
  const [showCourseCredits, setShowCourseCredits] = useState(false);
  const courseCreditPickerRef = useRef<HTMLDivElement>(null);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [newCourse, setNewCourse] = useState("COS 102");
  const [newDue, setNewDue] = useState("");
  const [newAssignmentCompleted, setNewAssignmentCompleted] = useState(false);

  useEffect(() => {
    if (!showCourseCredits) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !courseCreditPickerRef.current?.contains(event.target)) setShowCourseCredits(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowCourseCredits(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showCourseCredits]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const token = await getIdToken(user);
        const response = await fetch("/api/reminders/push/timetable", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json();
        if (active && Array.isArray(result.reminders)) setTimetableReminders(result.reminders);
      } catch { /* Timetable reminders load again when the signed-in workspace is reopened. */ }
    })();
    return () => { active = false; };
  }, [user]);

  useEffect(() => watchTimetableReminderPreferences(user.uid, (records) => {
    setTimetableReminders(records.map(({ sourceType, sourceId, leadMinutes }) => ({ sourceType, sourceId, leadMinutes })));
  }, () => undefined), [user.uid]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const token = await getIdToken(user);
        const response = await fetch("/api/reminders/push/assignment", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json();
        if (active && Array.isArray(result.reminders)) setAssignmentReminders(result.reminders);
      } catch { /* Assignment reminder state is refreshed when the workspace reopens. */ }
    })();
    return () => { active = false; };
  }, [user]);

  useEffect(() => watchAssignmentReminderPreferences(user.uid, (records) => {
    setAssignmentReminders(records.map(({ sourceId, dueDate, dueTime, leadMinutes }) => ({ assignmentId: sourceId, dueDate, dueTime, leadMinutes })));
  }, () => undefined), [user.uid]);

  async function syncTimetableReminderMirror(operation: Record<string, unknown>) {
    if (typeof operation.assignmentId === "string") {
      if (operation.action === "remove") await removeAssignmentReminderPreference(user.uid, operation.assignmentId);
      else if (operation.action === "add" && typeof operation.courseCode === "string" && typeof operation.dueDate === "string" && typeof operation.dueTime === "string" && typeof operation.leadMinutes === "number") {
        await saveAssignmentReminderPreference(user.uid, { sourceType: "assignment", sourceId: operation.assignmentId, courseCode: operation.courseCode, dueDate: operation.dueDate, dueTime: operation.dueTime, leadMinutes: operation.leadMinutes });
      }
    } else if (operation.action === "removeCourse" && typeof operation.courseCode === "string") {
      await removeCourseTimetableReminderPreferences(user.uid, operation.courseCode);
    } else if (operation.action === "remove" && (operation.sourceType === "weekly" || operation.sourceType === "exam") && typeof operation.sourceId === "string") {
      await removeTimetableReminderPreference(user.uid, operation.sourceType, operation.sourceId);
    } else if (operation.action === "add" && (operation.sourceType === "weekly" || operation.sourceType === "exam") && typeof operation.sourceId === "string" && typeof operation.courseCode === "string" && typeof operation.leadMinutes === "number") {
      await saveTimetableReminderPreference(user.uid, { sourceType: operation.sourceType, sourceId: operation.sourceId, courseCode: operation.courseCode.toUpperCase(), leadMinutes: operation.leadMinutes });
    }
  }

  useEffect(() => {
    if (!isOnline) return;
    const key = `campusos-timetable-reminder-sync:${user.uid}`;
    let active = true;
    let retryTimer: number | undefined;
    const retrySoon = () => {
      if (active && retryTimer === undefined) retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (active) setTimetableQueueVersion((version) => version + 1);
      }, 5000);
    };
    void (async () => {
      let queue: Array<Record<string, unknown>>;
      try { queue = JSON.parse(readStoredValue(key) ?? "[]"); } catch { queue = []; }
      if (!Array.isArray(queue) || !queue.length) return;
      try {
        const token = await getIdToken(user);
        while (active && queue.length) {
          const endpoint = typeof queue[0].assignmentId === "string" ? "/api/reminders/push/assignment" : "/api/reminders/push/timetable";
          const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(queue[0]) });
          if (!response.ok) { retrySoon(); break; }
          try { await syncTimetableReminderMirror(queue[0]); } catch { retrySoon(); break; }
          queue.shift();
          writeStoredValue(key, JSON.stringify(queue));
        }
      } catch { /* Keep queued timetable reminder changes for the next connection event. */ }
    })();
    return () => { active = false; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [isOnline, user, timetableQueueVersion]);

  function queueTimetableReminderSync(operation: Record<string, unknown>) {
    const key = `campusos-timetable-reminder-sync:${user.uid}`;
    let queue: Array<Record<string, unknown>>;
    try { queue = JSON.parse(readStoredValue(key) ?? "[]"); } catch { queue = []; }
    if (!Array.isArray(queue)) queue = [];
    queue.push(operation);
    writeStoredValue(key, JSON.stringify(queue));
    setTimetableQueueVersion((version) => version + 1);
  }

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updatePreference = () => setSystemPrefersDark(media.matches);
    let preferencePoll: number | undefined;
    const stopPreferencePoll = () => {
      if (preferencePoll !== undefined) {
        window.clearInterval(preferencePoll);
        preferencePoll = undefined;
      }
    };
    const syncPreference = () => {
      updatePreference();
      if (preferencePoll === undefined && isInstalledHomeScreenApp() && document.visibilityState === "visible") {
        preferencePoll = window.setInterval(updatePreference, 1000);
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") syncPreference();
      else stopPreferencePoll();
    };
    syncPreference();
    if (typeof media.addEventListener === "function") media.addEventListener("change", updatePreference);
    else media.addListener(updatePreference);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", syncPreference);
    window.addEventListener("pageshow", syncPreference);
    return () => {
      if (typeof media.removeEventListener === "function") media.removeEventListener("change", updatePreference);
      else media.removeListener(updatePreference);
      stopPreferencePoll();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", syncPreference);
      window.removeEventListener("pageshow", syncPreference);
    };
  }, []);

  useEffect(() => {
    writeStoredValue("campusos-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!reminderConfirmation && !timetableReminderRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReminderConfirmation(null);
        if (!timetableReminderBusy) setTimetableReminderRequest(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    const focusTimer = window.setTimeout(() => reminderCancelRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.clearTimeout(focusTimer);
    };
  }, [reminderConfirmation, timetableReminderRequest, timetableReminderBusy]);

  useEffect(() => {
    if (!timetableReminderRemovalRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !timetableReminderRemovalBusy) setTimetableReminderRemovalRequest(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [timetableReminderRemovalRequest, timetableReminderRemovalBusy]);

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
    if (!quickSearchOpen) return;
    const focusTimer = window.setTimeout(() => quickSearchInputRef.current?.focus(), 0);
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !quickSearchRef.current?.contains(event.target) && !quickSearchPopoverRef.current?.contains(event.target)) setQuickSearchOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuickSearchOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [quickSearchOpen]);

  useEffect(() => {
    const openSearchShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenuOpen(false);
        setThemeMenuOpen(false);
        setNotificationsOpen(false);
        setProfileOpen(false);
        setQuickSearchQuery("");
        setQuickSearchOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", openSearchShortcut);
    return () => document.removeEventListener("keydown", openSearchShortcut);
  }, []);

  useEffect(() => {
    const auth = firebaseAuth;
    if (!auth) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let signOutStarted = false;

    void user.getIdTokenResult().then(({ claims }) => {
      if (cancelled || typeof claims.auth_time !== "number") return;
      const authTime = claims.auth_time;
      unsubscribe = watchSessionRevocation(user.uid, authTime, () => {
        if (cancelled || signOutStarted) return;
        signOutStarted = true;
        void signOut(auth).catch(() => {
          setCloudMessage("This session was revoked. Sign out and sign back in to continue.");
        });
      }, () => {
        if (!cancelled) setCloudMessage("Session security could not sync. Check your connection.");
      });
    }).catch(() => {
      if (!cancelled) setCloudMessage("Session security could not be checked. Check your connection.");
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user]);

  useEffect(() => {
    const refreshPending = (event?: Event) => {
      if (event instanceof CustomEvent && event.detail?.uid === user.uid) {
        if (event.detail.failed) {
          const code = event.detail.code as string | undefined;
          const reason = code === "permission-denied"
            ? "Firestore rejected the sync. Check account access and database rules."
            : code === "unauthenticated"
              ? "Your sign-in expired. Sign in again to sync saved changes."
              : "The cloud request failed.";
          setSyncFailure(reason);
          setCloudMessage(`${reason} Your changes are backed up on this device and remain queued; CampusOS will retry automatically.`);
        } else {
          setSyncFailure("");
        }
      }
      void pendingWriteCount(user.uid).then((count) => {
        setPendingCount(count);
        if (count === 0 && event instanceof CustomEvent && event.detail?.uid === user.uid && !event.detail.failed) setCloudMessage("");
      }).catch(() => undefined);
    };
    const unsubscribe = [
      watchLocalRecords(user.uid, "courses", (records) => setCourses(normalizeCourseRecords(records))),
      watchLocalRecords(user.uid, "assignments", (records) => setAssignments(records as Assignment[])),
      watchLocalRecords(user.uid, "schedules", (records) => setSchedules(records as Schedule[])),
      watchLocalRecords(user.uid, "exams", (records) => setExams(records as Exam[])),
      watchLocalRecords(user.uid, "studentSections", (records) => {
        const value = records.find((record) => record.id === "studyNotes")?.["value"];
        setSearchMaterials(Array.isArray(value) ? value.filter(isStudyMaterial).map((item) => ({ id: item.id, title: item.title, category: item.category ?? "Study material", content: item.content ?? "", resourceUrl: item.resourceUrl ?? "" })) : []);
        const profile = records.find((record) => record.id === "profile");
        setStudentMatriculationNo(typeof profile?.studentId === "string" && profile.studentId.trim() && profile.studentId !== "Not provided" ? profile.studentId.trim() : "Not provided");
      }),
    ];
    const resumeSync = () => {
      if (!navigator.onLine) return;
      setIsOnline(true);
      refreshPending();
      if (firebaseConfigured) void syncPendingWrites(user.uid).finally(refreshPending);
    };
    const updateConnection = () => {
      const online = navigator.onLine;
      setIsOnline(online);
      if (online) resumeSync();
      else {
        setCloudConnected(false);
        setCloudMessage("You’re offline. Your courses, assignments, and timetable are backed up on this device and will sync when you reconnect.");
      }
      refreshPending();
    };
    const resumeWhenVisible = () => { if (document.visibilityState === "visible") resumeSync(); };
    const retryQueuedWrites = () => {
      if (!navigator.onLine || !firebaseConfigured) return;
      void pendingWriteCount(user.uid).then((count) => {
        setPendingCount(count);
        if (count > 0) void syncPendingWrites(user.uid).finally(refreshPending);
      }).catch(() => undefined);
    };
    const retryInterval = window.setInterval(retryQueuedWrites, 30_000);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    window.addEventListener("focus", resumeSync);
    window.addEventListener("pageshow", resumeSync);
    document.addEventListener("visibilitychange", resumeWhenVisible);
    window.addEventListener("campusos-sync", refreshPending);
    refreshPending();
    if (navigator.onLine) resumeSync();
    setCloudReady(true);
    if (!navigator.onLine) setCloudMessage("You’re offline. Your courses, assignments, and timetable are backed up on this device and will sync when you reconnect.");
    return () => {
      unsubscribe.forEach((stop) => stop());
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
      window.removeEventListener("focus", resumeSync);
      window.removeEventListener("pageshow", resumeSync);
      window.clearInterval(retryInterval);
      document.removeEventListener("visibilitychange", resumeWhenVisible);
      window.removeEventListener("campusos-sync", refreshPending);
    };
  }, [user.uid]);

  useEffect(() => {
    if (!queuedWriteCount && cloudReady && isOnline && !syncFailure) {
      setCloudMessage((message) => message.startsWith("Saved on this device") || message.startsWith("Cloud sync is temporarily unavailable") ? "" : message);
    }
  }, [queuedWriteCount, cloudReady, isOnline, syncFailure]);

  useEffect(() => {
    if (!firebaseConfigured) {
      setCloudReady(true);
      setCloudConnected(false);
      setCloudMessage("Cloud sync is not configured. Your records stay on this device.");
      return;
    }
    setCloudConnected(false);
    let readyParts = new Set<string>();
    let liveParts = new Set<string>();
    let unsubscribers: Array<() => void> = [];
    const markReady = (key: string, fromCache: boolean) => {
      readyParts.add(key);
      if (readyParts.size === 5) {
        setCloudReady(true);
        setCloudMessage((message) => message.startsWith("Loading your saved student data") ? "" : message);
      }
      if (fromCache) liveParts.delete(key);
      else {
        liveParts.add(key);
        setCloudMessage((message) => message.startsWith("Cloud sync is temporarily unavailable") || message.startsWith("You’re offline") ? "" : message);
      }
      // One server-confirmed snapshot is enough to establish database connectivity.
      // Keep all five listeners active and let each hydrate independently.
      setCloudConnected(liveParts.size > 0 && navigator.onLine);
    };
    const failed = (key?: string) => {
      if (key) liveParts.delete(key);
      setCloudConnected(liveParts.size > 0 && navigator.onLine);
      setCloudReady(true);
      setCloudMessage(navigator.onLine
        ? "Cloud sync is temporarily unavailable. Changes are saved on this device and queued for retry."
        : "You’re offline. Changes are backed up on this device and queued to sync when you reconnect.");
    };
    const clearLiveStatusWhenOffline = () => {
      if (!navigator.onLine) {
        liveParts.clear();
        setCloudConnected(false);
      }
    };
    window.addEventListener("offline", clearLiveStatusWhenOffline);
    unsubscribers = [
        watchStudentDocument(user.uid, (studentData, fromCache) => {
          if (studentData) void cacheStudentDocument(user.uid, studentData, !fromCache);
          const profileName = (studentData?.profile as Record<string, unknown> | undefined)?.fullName;
          if (typeof profileName === "string" && profileName.trim()) setStudentName(profileName);
          markReady("profile", fromCache);
        }, () => failed("profile")),
        watchStudentCollection(user.uid, "courses", (records, fromCache) => {
          const normalized = records.map((item) => ({ ...item, code: item.id }));
          // Keep the course code in the cached record as well as using it as its local ID.
          void replaceWithRemoteRecords(user.uid, "courses", normalized, !fromCache);
          setRecentCourseCodes(records
            .slice()
            .sort((left, right) => {
              const timestamp = (value: unknown) => typeof value === "number" ? value : (value as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
              return timestamp(right.createdAt) - timestamp(left.createdAt);
            })
            .map((item) => item.id)
            .slice(0, 6));
          markReady("courses", fromCache);
        }, () => failed("courses")),
        watchStudentCollection(user.uid, "assignments", (records, fromCache) => {
          void replaceWithRemoteRecords(user.uid, "assignments", records, !fromCache);
          markReady("assignments", fromCache);
        }, () => failed("assignments")),
        watchStudentCollection(user.uid, "schedules", (records, fromCache) => {
          void replaceWithRemoteRecords(user.uid, "schedules", records, !fromCache);
          markReady("schedules", fromCache);
        }, () => failed("schedules")),
        watchStudentCollection(user.uid, "exams", (records, fromCache) => {
          void replaceWithRemoteRecords(user.uid, "exams", records, !fromCache);
          markReady("exams", fromCache);
        }, () => failed("exams")),
    ];
    // Do not hold up live subscriptions on the optional first-login profile write.
    if (navigator.onLine) void ensureStudentRecord(user).catch(() => failed());
    if (navigator.onLine) void syncPendingWrites(user.uid);
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener("offline", clearLiveStatusWhenOffline);
    };
  }, [user.uid]);

  async function persistCloudRecord(save: () => Promise<void>) {
    try {
      await save();
      void pendingWriteCount(user.uid).then(setPendingCount).catch(() => undefined);
      setCloudMessage(navigator.onLine
        ? "Saved on this device. Cloud sync is running in the background."
        : "Saved on this device and queued to sync when you’re back online.");
      return true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      if (code.endsWith("permission-denied")) {
        setCloudMessage("Firestore denied this save. Make sure your email is verified and the database rules are up to date.");
      } else if (code.endsWith("unavailable") || code.endsWith("deadline-exceeded")) {
        setCloudMessage("Cloud sync is unavailable. Your entry is saved locally and queued for retry.");
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

  async function signOutOtherSessions() {
    const { claims } = await user.getIdTokenResult();
    if (typeof claims.auth_time !== "number") throw new Error("The current sign-in session could not be verified.");
    await revokeOtherSessionsRecord(user.uid, claims.auth_time);
  }

  useEffect(() => {
    if (!openCourseMenu) return;
    const closeMenuOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".course-menu-wrap, .task-menu-portal")) return;
      setOpenCourseMenu(null);
      setAssignmentMenuPosition(null);
    };
    document.addEventListener("pointerdown", closeMenuOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeMenuOnOutsideClick);
  }, [openCourseMenu]);

  useEffect(() => {
    if (!courseDeleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !courseDeleteBusy) setCourseDeleteRequest(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [courseDeleteRequest, courseDeleteBusy]);

  useEffect(() => {
    if (!assignmentDeleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !assignmentDeleteBusy) setAssignmentDeleteRequest(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [assignmentDeleteRequest, assignmentDeleteBusy]);

  useEffect(() => {
    if (!assignmentReminderRemovalRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !assignmentReminderRemovalBusy) setAssignmentReminderRemovalRequest(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [assignmentReminderRemovalRequest, assignmentReminderRemovalBusy]);

  useEffect(() => {
    if (!timetableDeleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !timetableDeleteBusy) setTimetableDeleteRequest(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [timetableDeleteRequest, timetableDeleteBusy]);

  function toggleAssignmentMenu(event: React.MouseEvent<HTMLButtonElement>, recordId: string, menuId = `assignment-${recordId}`, menuHeight?: number) {
    if (openCourseMenu === menuId) {
      setOpenCourseMenu(null);
      setAssignmentMenuPosition(null);
      return;
    }
    const trigger = event.currentTarget.getBoundingClientRect();
    const menuWidth = Math.min(190, window.innerWidth - 16);
    const resolvedMenuHeight = menuHeight ?? (window.matchMedia("(pointer: coarse)").matches ? 108 : 82);
    const left = Math.max(8, Math.min(trigger.right - menuWidth, window.innerWidth - menuWidth - 8));
    const below = trigger.bottom + 8;
    const maxTop = Math.max(8, window.innerHeight - resolvedMenuHeight - 8);
    const top = below + resolvedMenuHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, Math.min(trigger.top - resolvedMenuHeight - 8, maxTop));
    setAssignmentMenuPosition({ top, left });
    setOpenCourseMenu(menuId);
  }

  async function saveCourse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = newCourseCode.trim().toUpperCase();
    const name = newCourseName.trim();
    if (!code || !name || courses.some((course) => course.code === code && course.code !== editingCourseCode)) return;
    const course = { code, name, color: "leather", creditUnits: newCourseCreditUnits };
    const saved = await persistCloudRecord(() => editingCourseCode
      ? renameCourseRecord(user.uid, editingCourseCode, code, course)
      : saveCourseRecord(user.uid, code, course));
    if (!saved) return;
    setNewCourseCode("");
    setNewCourseName("");
    setNewCourseCreditUnits(1);
    setShowCourseCredits(false);
    setEditingCourseCode(null);
    setShowCourseForm(false);
  }

  function resetAssignmentForm() {
    setNewTitle("");
    setNewQuestion("");
    setNewCourse(courses[0]?.code ?? "");
    setNewDue("");
    setNewAssignmentCompleted(false);
  }

  function startNewCourse() {
    if (showCourseForm && !editingCourseCode) {
      setShowCourseForm(false);
      return;
    }
    setEditingCourseCode(null);
    setNewCourseCode("");
    setNewCourseName("");
    setNewCourseCreditUnits(1);
    setShowCourseCredits(false);
    setShowCourseForm(true);
  }

  function beginEditCourse(code: string) {
    const normalizedCode = code.trim().toUpperCase();
    const course = courses.find((item) => item.code.trim().toUpperCase() === normalizedCode);
    setEditingCourseCode(course?.code ?? null);
    setNewCourseCode(course?.code ?? normalizedCode);
    setNewCourseName(course?.name ?? normalizedCode);
    setNewCourseCreditUnits(course?.creditUnits ?? 1);
    setShowCourseCredits(false);
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
    const id = editingScheduleId ?? createRecordId();
    const saved = await persistCloudRecord(async () => {
      if (!existing) await saveCourseRecord(user.uid, code, { code, name, color: "leather" });
      await saveScheduleRecord(user.uid, id, { courseCode: code, day: scheduleDay, start: scheduleStart, end: scheduleEnd }, !editingScheduleId);
    });
    if (!saved) return;
    const activeReminder = timetableReminders.find((item) => item.sourceType === "weekly" && item.sourceId === id);
    if (activeReminder) {
      try { await persistTimetableReminder({ type: "weekly", entry: { id, courseCode: code, day: scheduleDay, start: scheduleStart, end: scheduleEnd } }, activeReminder.leadMinutes); }
      catch (error) {
        queueTimetableReminderSync({ action: "add", sourceType: "weekly", sourceId: id, title: name, courseCode: code, dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(scheduleDay), time: scheduleStart, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", leadMinutes: activeReminder.leadMinutes });
        setReminderMessage(error instanceof Error ? `Schedule saved. Its notification update is queued for sync: ${error.message}` : "Schedule saved. Its notification update is queued for sync."); setNotificationsOpen(true);
      }
    }
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

  function removeCourse(code: string) {
    const normalizedCode = code.trim().toUpperCase();
    const course = courses.find((item) => item.code.trim().toUpperCase() === normalizedCode) ?? { code: normalizedCode, name: normalizedCode, color: "leather" };
    setOpenCourseMenu(null);
    setCourseDeleteRequest(course);
  }

  async function confirmCourseDelete() {
    const request = courseDeleteRequest;
    if (!request || courseDeleteBusy) return;
    setCourseDeleteBusy(true);
    try {
      const removal = { action: "removeCourse", courseCode: request.code };
      if (!navigator.onLine) queueTimetableReminderSync(removal);
      else {
        try {
          const token = await getIdToken(user);
          const reminderResponse = await fetch("/api/reminders/push/timetable", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(removal) });
          if (!reminderResponse.ok) throw new Error("Could not clear timetable reminders.");
          await removeCourseTimetableReminderPreferences(user.uid, request.code);
        } catch {
          queueTimetableReminderSync(removal);
          setReminderMessage("Course deletion is saved. Its notification cleanup is queued for sync."); setNotificationsOpen(true);
        }
      }
      setTimetableReminders((current) => current.filter((item) => {
        const entry = item.sourceType === "weekly" ? schedules.find((schedule) => schedule.id === item.sourceId) : exams.find((exam) => exam.id === item.sourceId);
        return entry?.courseCode !== request.code;
      }));
      const saved = await persistCloudRecord(() => deleteCourseRecord(user.uid, request.code));
      if (saved) setCourseDeleteRequest(null);
    } finally {
      setCourseDeleteBusy(false);
    }
  }

  function removeSchedule(id: string) {
    const entry = schedules.find((schedule) => schedule.id === id);
    if (!entry) return;
    setOpenCourseMenu(null);
    setTimetableDeleteRequest({ type: "weekly", entry });
  }

  async function confirmTimetableDelete() {
    const request = timetableDeleteRequest;
    if (!request || timetableDeleteBusy) return;
    setTimetableDeleteBusy(true);
    try {
      const hasReminder = timetableReminders.some((item) => item.sourceType === request.type && item.sourceId === request.entry.id);
      if (hasReminder && !(await removeTimetableReminder(request, false))) return;
      const saved = await persistCloudRecord(() => request.type === "weekly"
        ? deleteScheduleRecord(user.uid, request.entry.id)
        : deleteExamRecord(user.uid, request.entry.id));
      if (saved) setTimetableDeleteRequest(null);
    } finally {
      setTimetableDeleteBusy(false);
    }
  }

  async function saveExam(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = examDraft.title.trim();
    const courseCode = examDraft.courseCode.trim().toUpperCase();
    const date = examDraft.date;
    const start = examDraft.start;
    const location = examDraft.location.trim();
    if (!title || !courseCode || !date || !start || !location) return;
    const id = editingExamId ?? createRecordId();
    const saved = await persistCloudRecord(() => saveExamRecord(user.uid, id, { title, courseCode, date, start, location }, !editingExamId));
    if (saved) {
      const activeReminder = timetableReminders.find((item) => item.sourceType === "exam" && item.sourceId === id);
      if (activeReminder) {
        try { await persistTimetableReminder({ type: "exam", entry: { id, title, courseCode, date, start, location } }, activeReminder.leadMinutes); }
        catch (error) {
          queueTimetableReminderSync({ action: "add", sourceType: "exam", sourceId: id, title, courseCode, date, time: start, location, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", leadMinutes: activeReminder.leadMinutes });
          setReminderMessage(error instanceof Error ? `Exam saved. Its notification update is queued for sync: ${error.message}` : "Exam saved. Its notification update is queued for sync."); setNotificationsOpen(true);
        }
      }
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

  function removeExam(id: string) {
    const entry = exams.find((exam) => exam.id === id);
    if (!entry) return;
    setOpenCourseMenu(null);
    setTimetableDeleteRequest({ type: "exam", entry });
  }

  function openTimetableReminder(request: { type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam }) {
    const saved = timetableReminders.find((item) => item.sourceType === request.type && item.sourceId === request.entry.id);
    setTimetableReminderLead(saved?.leadMinutes ?? 15);
    setTimetableReminderRequest(request);
    setOpenCourseMenu(null);
    setAssignmentMenuPosition(null);
  }

  async function ensureTimetablePushSubscription() {
    const configResponse = await fetch("/api/reminders/push/config", { cache: "no-store" });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok || !config.configured || typeof config.publicKey !== "string") throw new Error("Background push reminders are not configured yet. Try again later.");
    const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
      ?? await navigator.serviceWorker.register("/service-worker.js");
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const oldKey = subscription.options.applicationServerKey;
      const newKey = base64UrlToBytes(config.publicKey);
      if (!oldKey || new Uint8Array(oldKey).length !== newKey.length || !new Uint8Array(oldKey).every((byte, index) => byte === newKey[index])) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(config.publicKey) });
    const token = await getIdToken(user);
    const saved = await fetch("/api/reminders/push/subscribe", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ subscription: subscription.toJSON() }) });
    if (!saved.ok) throw new Error((await saved.json().catch(() => ({}))).error || "Could not enable notifications on this device.");
  }

  async function persistTimetableReminder(request: { type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam }, leadMinutes: number) {
    const entry = request.entry;
    const sourceType = request.type;
    const course = courses.find((item) => item.code === entry.courseCode);
    const payload = {
      action: "add",
      sourceType,
      sourceId: entry.id,
      title: request.type === "exam" ? request.entry.title : course?.name ?? entry.courseCode,
      courseCode: entry.courseCode,
      time: entry.start,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      leadMinutes,
      ...(request.type === "weekly" ? { dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(request.entry.day) } : { date: request.entry.date, location: request.entry.location }),
    };
    const token = await getIdToken(user);
    const response = await fetch("/api/reminders/push/timetable", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Could not save this timetable reminder.");
    try { await syncTimetableReminderMirror(payload); }
    catch { queueTimetableReminderSync(payload); }
    return payload.title;
  }

  async function confirmAddTimetableReminder() {
    const request = timetableReminderRequest;
    if (!request || timetableReminderBusy) return;
    if (!navigator.onLine) { setReminderMessage("Connect to the internet to add a background timetable reminder."); setNotificationsOpen(true); return; }
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setReminderMessage("This browser does not support background push reminders."); setNotificationsOpen(true); return;
    }
    const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (isAppleMobile && !standalone) { setReminderMessage("Add CampusOS to your Home Screen in Safari, then open the installed app to enable push reminders."); setNotificationsOpen(true); return; }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") { setReminderMessage("Allow notifications for CampusOS to add timetable reminders."); setNotificationsOpen(true); return; }

    setTimetableReminderBusy(true);
    try {
      await ensureTimetablePushSubscription();
      const title = await persistTimetableReminder(request, timetableReminderLead);
      setTimetableReminders((current) => [...current.filter((item) => item.sourceType !== request.type || item.sourceId !== request.entry.id), { sourceType: request.type, sourceId: request.entry.id, leadMinutes: timetableReminderLead }]);
      setTimetableReminderRequest(null);
      setReminderMessage(`Reminder set for ${title}, ${timetableReminderLead} minutes before ${request.type === "weekly" ? "class" : "the exam"}.`);
      setNotificationsOpen(true);
    } catch (error) {
      setReminderMessage(error instanceof Error ? error.message : "Could not add the timetable reminder.");
      setNotificationsOpen(true);
    } finally { setTimetableReminderBusy(false); }
  }

  async function removeTimetableReminder(request: { type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam }, showMessage = true): Promise<boolean> {
    const operation = { action: "remove", sourceType: request.type, sourceId: request.entry.id };
    if (!navigator.onLine) {
      queueTimetableReminderSync(operation);
      setTimetableReminders((current) => current.filter((item) => item.sourceType !== request.type || item.sourceId !== request.entry.id));
      if (showMessage) { setReminderMessage("Reminder removal is saved and will sync when you are back online."); setNotificationsOpen(true); }
      setOpenCourseMenu(null);
      return true;
    }
    try {
      const token = await getIdToken(user);
      const response = await fetch("/api/reminders/push/timetable", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(operation) });
      if (!response.ok) throw new Error("Could not remove this notification reminder. Try again when connected.");
      try { await syncTimetableReminderMirror(operation); }
      catch { queueTimetableReminderSync(operation); }
      setTimetableReminders((current) => current.filter((item) => item.sourceType !== request.type || item.sourceId !== request.entry.id));
      if (showMessage) { setReminderMessage("Timetable notification reminder removed."); setNotificationsOpen(true); }
      setOpenCourseMenu(null);
      return true;
    } catch (error) {
      setReminderMessage(error instanceof Error ? error.message : "Could not remove this notification reminder.");
      setNotificationsOpen(true);
      return false;
    }
  }

  async function confirmTimetableReminderRemoval() {
    const request = timetableReminderRemovalRequest;
    if (!request || timetableReminderRemovalBusy) return;
    setTimetableReminderRemovalBusy(true);
    try {
      if (await removeTimetableReminder(request)) setTimetableReminderRemovalRequest(null);
    } finally {
      setTimetableReminderRemovalBusy(false);
    }
  }

  function requestTimetableReminderRemoval(request: { type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam }) {
    setAssignmentMenuPosition(null);
    setOpenCourseMenu(null);
    setTimetableReminderRemovalRequest(request);
  }

  function removeAssignment(id: string) {
    const assignment = assignments.find((item) => item.id === id);
    if (!assignment) return;
    setAssignmentMenuPosition(null);
    setOpenCourseMenu(null);
    setAssignmentDeleteRequest(assignment);
  }

  async function confirmAssignmentDelete() {
    const request = assignmentDeleteRequest;
    if (!request || assignmentDeleteBusy) return;
    setAssignmentDeleteBusy(true);
    try {
      if (assignmentReminders.some((item) => item.assignmentId === request.id)) await removeAssignmentReminder(request.id, false);
      const saved = await persistCloudRecord(() => deleteAssignmentRecord(user.uid, request.id));
      if (saved) setAssignmentDeleteRequest(null);
    } finally {
      setAssignmentDeleteBusy(false);
    }
  }

  async function setAssignmentCompletion(id: string, completed: boolean) {
    const assignment = assignments.find((item) => item.id === id);
    if (!assignment) return;
    if (completed && assignmentReminders.some((item) => item.assignmentId === id)) await removeAssignmentReminder(id, false);
    await persistCloudRecord(() => saveAssignmentRecord(user.uid, id, { ...assignment, completed, studentId: assignment.studentId ?? studentMatriculationNo }, false));
  }

  async function postAssignmentReminder(operation: Record<string, unknown>) {
    if (!navigator.onLine) throw new Error("Connect to the internet to schedule an assignment notification.");
    const token = await getIdToken(user);
    const response = await fetch("/api/reminders/push/assignment", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(operation) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Could not save the assignment reminder.");
    try { await syncTimetableReminderMirror(operation); }
    catch { queueTimetableReminderSync(operation); }
  }

  async function removeAssignmentReminder(assignmentId: string, showMessage = true) {
    const operation = { action: "remove", assignmentId };
    if (!navigator.onLine) queueTimetableReminderSync(operation);
    else {
      try { await postAssignmentReminder(operation); }
      catch { queueTimetableReminderSync(operation); }
    }
    setAssignmentReminders((current) => current.filter((item) => item.assignmentId !== assignmentId));
    if (showMessage) { setReminderMessage("Assignment notification reminder removed."); setNotificationsOpen(true); }
  }

  async function confirmAssignmentReminderRemoval() {
    const assignment = assignmentReminderRemovalRequest;
    if (!assignment || assignmentReminderRemovalBusy) return;
    setAssignmentReminderRemovalBusy(true);
    try {
      await removeAssignmentReminder(assignment.id, false);
      setAssignmentReminderRemovalRequest(null);
      setReminderMessage(navigator.onLine
        ? `Notification reminder removed for ${assignment.title}.`
        : `Reminder removal for ${assignment.title} is saved and will sync when you reconnect.`);
      setNotificationsOpen(true);
    } finally {
      setAssignmentReminderRemovalBusy(false);
    }
  }

  function requestAssignmentReminderRemoval(assignment: Assignment) {
    setAssignmentMenuPosition(null);
    setOpenCourseMenu(null);
    setAssignmentReminderRemovalRequest(assignment);
  }

  function openAssignmentReminder(assignment: Assignment) {
    const saved = assignmentReminders.find((item) => item.assignmentId === assignment.id);
    setAssignmentReminderDate(assignment.dueDate ?? saved?.dueDate ?? "");
    setAssignmentReminderTime(saved?.dueTime ?? "09:00");
    setAssignmentReminderLead(saved?.leadMinutes ?? 60);
    setAssignmentReminderRequest(assignment);
    setAssignmentMenuPosition(null);
    setOpenCourseMenu(null);
  }

  async function confirmAssignmentReminder() {
    const assignment = assignmentReminderRequest;
    if (!assignment || assignmentReminderBusy) return;
    if (!assignmentReminderDate) { setReminderMessage("Choose the assignment due date to schedule its reminder."); setNotificationsOpen(true); return; }
    if (!navigator.onLine) { setReminderMessage("Connect to the internet to schedule an assignment notification."); setNotificationsOpen(true); return; }
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) { setReminderMessage("This browser does not support background push reminders."); setNotificationsOpen(true); return; }
    const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (isAppleMobile && !standalone) { setReminderMessage("Add CampusOS to your Home Screen in Safari, then open the installed app to enable push reminders."); setNotificationsOpen(true); return; }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") { setReminderMessage("Allow notifications for CampusOS to add assignment reminders."); setNotificationsOpen(true); return; }

    setAssignmentReminderBusy(true);
    try {
      await ensureTimetablePushSubscription();
      const operation = { action: "add", assignmentId: assignment.id, title: assignment.title, courseCode: assignment.course, dueDate: assignmentReminderDate, dueTime: assignmentReminderTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", leadMinutes: assignmentReminderLead };
      await postAssignmentReminder(operation);
      setAssignmentReminders((current) => [...current.filter((item) => item.assignmentId !== assignment.id), { assignmentId: assignment.id, dueDate: assignmentReminderDate, dueTime: assignmentReminderTime, leadMinutes: assignmentReminderLead }]);
      setAssignmentReminderRequest(null);
      setReminderMessage(`Reminder set for ${assignment.title}.`);
      setNotificationsOpen(true);
    } catch (error) {
      setReminderMessage(error instanceof Error ? error.message : "Could not add the assignment reminder.");
      setNotificationsOpen(true);
    } finally { setAssignmentReminderBusy(false); }
  }

  function beginEditAssignment(assignment: Assignment) {
    setEditingAssignmentId(assignment.id);
    setAssignmentDraft({ title: assignment.title, question: assignment.description ?? assignment.question, course: assignment.course, due: assignment.dueDate ?? "" });
    setOpenCourseMenu(null);
  }

  async function saveAssignmentEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAssignmentId || !assignmentDraft.title.trim() || !assignmentDraft.question.trim() || !assignmentDraft.due.trim()) return;
    const existing = assignments.find((item) => item.id === editingAssignmentId);
    const description = assignmentDraft.question.trim();
    const assignment = { ...assignmentDraft, title: assignmentDraft.title.trim(), question: description, description, due: formatAssignmentDueDate(assignmentDraft.due), dueDate: assignmentDraft.due, completed: existing?.completed ?? false, studentId: existing?.studentId ?? studentMatriculationNo, ...(existing?.createdAt !== undefined ? { createdAt: existing.createdAt } : {}) };
    const saved = await persistCloudRecord(() => saveAssignmentRecord(user.uid, editingAssignmentId, assignment, false));
    if (saved) {
      const activeReminder = assignmentReminders.find((item) => item.assignmentId === editingAssignmentId);
      if (activeReminder) {
        const updatedReminder = { action: "add", assignmentId: editingAssignmentId, title: assignment.title, courseCode: assignment.course, dueDate: assignment.dueDate, dueTime: activeReminder.dueTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", leadMinutes: activeReminder.leadMinutes };
        try {
          await postAssignmentReminder(updatedReminder);
          setAssignmentReminders((current) => current.map((item) => item.assignmentId === editingAssignmentId ? { ...item, dueDate: assignment.dueDate } : item));
        } catch (error) { setReminderMessage(error instanceof Error ? `Assignment saved. Reminder update failed: ${error.message}` : "Assignment saved. Reminder update failed."); setNotificationsOpen(true); }
      }
      setEditingAssignmentId(null);
    }
  }

  async function addAssignment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!newTitle.trim() || !newDue) return;

    const formattedDate = formatAssignmentDueDate(newDue);

    const id = createRecordId();
    const saved = await persistCloudRecord(() => saveAssignmentRecord(user.uid, id, {
      title: newTitle.trim(), question: newQuestion.trim(), description: newQuestion.trim(), course: newCourse, due: formattedDate, dueDate: newDue, completed: newAssignmentCompleted,
      studentId: studentMatriculationNo, createdAt: Date.now(),
    }, true));
    if (!saved) return;

    resetAssignmentForm();
    setShowForm(false);
    setActivePage("Assignments");
  }

  const pendingCount = assignments.filter(
    (assignment) => !assignment.completed,
  ).length;

  const completedCount = assignments.filter(
    (assignment) => assignment.completed,
  ).length;

  async function sendDesktopReminders() {
    if (typeof Notification === "undefined") {
      setReminderMessage("This browser does not support notifications on this page. On iPhone or iPad, add CampusOS to your Home Screen and open the installed app to enable device notifications.");
      return;
    }
    const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (isAppleMobile && !isStandalone) {
      setReminderMessage("On iPhone or iPad, first add CampusOS to your Home Screen using Safari’s Share menu, then open the installed app to enable notifications.");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setReminderMessage("Notifications are blocked. Allow notifications in your browser to receive these reminders.");
      return;
    }
    const pending = assignments.filter((assignment) => !assignment.completed);
    if (!pending.length) {
      setReminderMessage("Device notifications are allowed. Add a pending assignment to send a reminder.");
      return;
    }
    let registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
    try {
      if (!registration && "serviceWorker" in navigator) registration = await navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
      if (registration && "PushManager" in window && user.emailVerified) {
        const configResponse = await fetch("/api/reminders/push/config", { cache: "no-store" });
        const config = await configResponse.json().catch(() => ({}));
        if (configResponse.ok && typeof config.publicKey === "string" && config.publicKey) {
          let subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            const existingKey = subscription.options.applicationServerKey;
            const requestedKey = base64UrlToBytes(config.publicKey);
            const matchesKey = existingKey && new Uint8Array(existingKey).length === requestedKey.length && new Uint8Array(existingKey).every((byte, index) => byte === requestedKey[index]);
            if (!matchesKey) { await subscription.unsubscribe(); subscription = null; }
          }
          subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(config.publicKey) });
          const idToken = await getIdToken(user);
          const authHeaders = { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" };
          const subscribed = await fetch("/api/reminders/push/subscribe", { method: "POST", headers: authHeaders, body: JSON.stringify({ subscription: subscription.toJSON() }) });
          if (!subscribed.ok) throw new Error((await subscribed.json().catch(() => ({}))).error || "Could not register this device for push reminders.");
          const sent = await fetch("/api/reminders/push/send", { method: "POST", headers: authHeaders, body: JSON.stringify({ reminders: pending.slice(0, 20).map(({ id, title, course, due }) => ({ id, title, course, due })) }) });
          const result = await sent.json().catch(() => ({}));
          if (sent.ok) {
            setReminderMessage(`Sent ${result.count} background reminder${result.count === 1 ? "" : "s"}. This device is subscribed for future push reminders.`);
            return;
          }
          if (sent.status === 503 && String(result.error ?? "").includes("not configured")) {
            for (const assignment of pending) await registration.showNotification(`Assignment reminder: ${assignment.title}`, { body: `${assignment.course} · Due ${assignment.due}`, icon: "/campusos-icon.svg", badge: "/campusos-icon.svg", tag: `assignment-${assignment.id}`, silent: !soundEnabled, data: { url: "/" } });
            setReminderMessage("Reminders were shown on this device. Background delivery needs the push service to be configured on the CampusOS server.");
            return;
          }
          throw new Error(typeof result.error === "string" ? result.error : "The push service could not deliver reminders.");
        }
      }
      for (const assignment of pending) {
        const options = {
          body: `${assignment.course} · Due ${assignment.due}`,
          icon: "/campusos-icon.svg",
          badge: "/campusos-icon.svg",
          tag: `assignment-${assignment.id}`,
          renotify: false,
          silent: !soundEnabled,
          data: { url: "/" },
        };
        if (registration && "showNotification" in registration) await registration.showNotification(`Assignment reminder: ${assignment.title}`, options);
        else new Notification(`Assignment reminder: ${assignment.title}`, options);
      }
      setReminderMessage(`${pending.length} pending assignment ${pending.length === 1 ? "reminder was" : "reminders were"} shown on this device. Background delivery is unavailable in this browser or is not configured yet.`);
    } catch (error) {
      if (registration && "showNotification" in registration && Notification.permission === "granted") {
        for (const assignment of pending) await registration.showNotification(`Assignment reminder: ${assignment.title}`, { body: `${assignment.course} · Due ${assignment.due}`, icon: "/campusos-icon.svg", badge: "/campusos-icon.svg", tag: `assignment-${assignment.id}`, silent: !soundEnabled, data: { url: "/" } });
        setReminderMessage("Reminders were shown on this device. Background delivery could not be reached; CampusOS will use this device again when you retry.");
      } else setReminderMessage(error instanceof Error ? error.message : "The browser could not send reminders. Check notification permissions and try again.");
    }
  }

  async function emailPendingReminders() {
    if (emailReminderSending) return;
    const pending = assignments.filter((assignment) => !assignment.completed);
    if (!pending.length) return setReminderMessage("You are all caught up. There are no pending assignments.");
    if (!user.email || !user.emailVerified) return setReminderMessage("Verify your signed-in email address before sending reminders.");
    if (!navigator.onLine) return setReminderMessage("Email reminders need an internet connection. Your assignments remain saved on this device.");
    setEmailReminderSending(true);
    try {
      const idToken = await getIdToken(user);
      const response = await fetch("/api/reminders/email", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reminders: pending.slice(0, 20).map(({ title, course, due }) => ({ title, course, due })) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Could not send email reminders.");
      setReminderMessage(`Sent ${result.count} assignment reminder${result.count === 1 ? "" : "s"} to ${user.email}.`);
    } catch (error) {
      setReminderMessage(error instanceof Error ? error.message : "Could not send email reminders. Try again later.");
    } finally {
      setEmailReminderSending(false);
    }
  }

  const navigation = [
    { name: "Home", page: "Dashboard", icon: "⌂" },
    { name: "My Courses", page: "My Courses", icon: "▤" },
    { name: "Assignments", page: "Assignments", icon: "✓" },
    { name: "Timetable", page: "Timetable", icon: "▦" },
    { name: "Notes & Resources", page: "Notes & Resources", icon: "▧" },
    { name: "Grade Calculator", page: "Grade Calculator", icon: "∑" },
    { name: "Cloud Database", page: "Cloud Database", icon: "☁" },
    { name: "Backup & Recovery", page: "Backup & Recovery", icon: "↻" },
  ];
  const quickSearchCatalog: QuickSearchResult[] = [
    ...courses.map((course) => ({ id: course.code, title: course.code, detail: course.name, category: "Course", page: "My Courses", searchable: `${course.code} ${course.name}` })),
    ...assignments.map((assignment) => ({ id: assignment.id, title: assignment.title, detail: `${assignment.course} · due ${assignment.due}`, category: "Assignment", page: "Assignments", searchable: `${assignment.title} ${assignment.question} ${assignment.course} ${assignment.due}` })),
    ...schedules.map((schedule) => {
      const course = courses.find((item) => item.code === schedule.courseCode);
      return { id: schedule.id, title: course?.name ?? schedule.courseCode, detail: `${schedule.courseCode} · ${schedule.day} · ${schedule.start}–${schedule.end}`, category: "Timetable", page: "Timetable", searchable: `${course?.name ?? ""} ${schedule.courseCode} ${schedule.day} ${schedule.start} ${schedule.end}` };
    }),
    ...exams.map((exam) => ({ id: exam.id, title: exam.title, detail: `${exam.courseCode} · ${exam.date} · ${exam.location}`, category: "Exam timetable", page: "Timetable", searchable: `${exam.title} ${exam.courseCode} ${exam.date} ${exam.location}` })),
    ...searchMaterials.map((material) => ({ id: material.id, title: material.title, detail: [material.category, material.content, material.resourceUrl].filter(Boolean).join(" · "), category: material.resourceUrl ? "Note & resource" : "Study note", page: "Notes & Resources", searchable: `${material.title} ${material.category} ${material.content} ${material.resourceUrl}` })),
  ];
  const normalizedSearchQuery = quickSearchQuery.trim().toLocaleLowerCase();
  const quickSearchMatches = normalizedSearchQuery
    ? quickSearchCatalog.filter((item) => `${item.title} ${item.detail} ${item.searchable}`.toLocaleLowerCase().includes(normalizedSearchQuery)).slice(0, 12)
    : [];
  function openSearchResult(result: QuickSearchResult) {
    setActivePage(result.page);
    setShowForm(false);
    setMenuOpen(false);
    setSearchTargetId(result.id);
    setQuickSearchOpen(false);
    setQuickSearchQuery("");
    if (result.page !== "Notes & Resources") {
      window.setTimeout(() => {
        const target = Array.from(document.querySelectorAll<HTMLElement>("[data-search-id]"))
          .find((element) => element.dataset.searchId === result.id);
        if (!target) return;
        target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.classList.add("search-result-focus");
        window.setTimeout(() => target.classList.remove("search-result-focus"), 1800);
      }, 100);
    }
  }
  const activeTheme = themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const color = activeTheme === "dark" ? "#1d2024" : "#f7f8fc";
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => { meta.content = color; });
  }, [activeTheme]);

  return (
    <div className="app-shell" data-theme={activeTheme}>
      <main className="main-content">
        <header className={`topbar ${quickSearchOpen ? "search-open" : ""}`}>
          <div className="topbar-left">
            <button className={`menu-trigger ${menuOpen ? "open" : ""}`} aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen} onClick={() => { setQuickSearchOpen(false); setQuickSearchQuery(""); setThemeMenuOpen(false); setNotificationsOpen(false); setProfileOpen(false); setMenuOpen((open) => !open); }}>
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
            <div className="quick-search-control" ref={quickSearchRef}>
              <button className="quick-search-trigger" type="button" aria-label="Search courses, assignments, timetable, notes, and resources" aria-expanded={quickSearchOpen} aria-haspopup="dialog" title="Search (⌘K / Ctrl K)" onClick={() => { setMenuOpen(false); setThemeMenuOpen(false); setNotificationsOpen(false); setProfileOpen(false); setQuickSearchQuery(""); setQuickSearchOpen((open) => !open); }}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>
              </button>
            </div>
            <div className="theme-control" ref={themeMenuRef}>
              <button className="theme-trigger" aria-label={`Appearance: ${themeMode}`} aria-expanded={themeMenuOpen} aria-haspopup="menu" title={`Appearance: ${themeMode}`} onClick={() => { setMenuOpen(false); setQuickSearchOpen(false); setQuickSearchQuery(""); setNotificationsOpen(false); setProfileOpen(false); setThemeMenuOpen((open) => !open); }}>
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
              <button className="notification-open-button" aria-label={notificationsOpen ? "Close assignment reminders" : "Open assignment reminders"} aria-expanded={notificationsOpen} onClick={() => { setMenuOpen(false); setQuickSearchOpen(false); setQuickSearchQuery(""); setThemeMenuOpen(false); setProfileOpen(false); setNotificationsOpen((open) => !open); setReminderMessage(""); }}>⌄</button>
            </div>
            <button className="avatar small-avatar profile-avatar-button" aria-label={`Open ${studentName} profile`} aria-expanded={profileOpen} onClick={() => { setMenuOpen(false); setQuickSearchOpen(false); setQuickSearchQuery(""); setThemeMenuOpen(false); setNotificationsOpen(false); setProfileOpen((open) => !open); }}>{getStudentInitials(studentName)}</button>
          </div>
        </header>
        {quickSearchOpen && createPortal(<section ref={quickSearchPopoverRef} className="quick-search-popover liquid-glass" data-theme={activeTheme} role="dialog" aria-label="Search your CampusOS workspace">
          <div className="quick-search-input-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg><input ref={quickSearchInputRef} type="search" role="searchbox" aria-label="Search your records" value={quickSearchQuery} onChange={(event) => setQuickSearchQuery(event.target.value)} placeholder="Search courses, assignments…" autoComplete="off" /><button className="quick-search-clear" type="button" aria-label="Clear search" title="Clear search" disabled={!quickSearchQuery} onClick={() => { setQuickSearchQuery(""); quickSearchInputRef.current?.focus(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg><span>Clear</span></button></div>
          {normalizedSearchQuery ? <div className="quick-search-results" role="listbox" aria-label="Search results">
            {quickSearchMatches.map((result) => <button key={`${result.category}-${result.id}`} type="button" role="option" aria-selected="false" className="quick-search-result" onClick={() => openSearchResult(result)}><span className="quick-search-result-icon">⌕</span><span className="quick-search-result-copy"><strong>{result.title}</strong><small>{result.detail || result.category}</small></span><span className="quick-search-result-type">{result.category}</span></button>)}
            {quickSearchMatches.length === 0 && <p className="quick-search-empty">No matching courses, tasks, timetable entries, or study materials.</p>}
          </div> : <div className="quick-search-shortcuts"><p>QUICK ACCESS</p>{navigation.filter((item) => ["My Courses", "Assignments", "Timetable", "Notes & Resources"].includes(item.page)).map((item) => <button type="button" key={item.page} onClick={() => { setActivePage(item.page); setQuickSearchOpen(false); setQuickSearchQuery(""); }}><span>{item.icon}</span>{item.name}<span aria-hidden="true">↗</span></button>)}</div>}
          <p className="quick-search-hint">Search is private and uses records saved for your account.</p>
        </section>, document.body)}
        {notificationsOpen && (
          <>
            <button className="reminder-backdrop" aria-label="Close assignment reminders" onClick={() => setNotificationsOpen(false)} />
            <section className="notification-panel liquid-glass" aria-label="Pending assignment reminders">
              <header className="notification-panel-heading"><div><p className="profile-kicker">CAMPUSOS REMINDERS</p><h2>Pending assignments</h2></div><button className="notification-panel-close" type="button" aria-label="Close CampusOS reminders" title="Close reminders" onClick={() => setNotificationsOpen(false)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></header>
              <div className="reminder-task-list">
                {assignments.filter((assignment) => !assignment.completed).map((assignment) => <article className="reminder-task" key={assignment.id}><strong>{assignment.title}</strong><span>{assignment.course} · Due {assignment.due}</span></article>)}
                {pendingCount === 0 && <p className="empty-state">You are all caught up.</p>}
              </div>
              {reminderMessage && <p className="reminder-message" role="status">{reminderMessage}</p>}
              <div className="reminder-actions">
                <button className="primary-button reminder-send-button" onClick={() => setReminderConfirmation("desktop")}>Device notification</button>
                <button className="primary-button reminder-email-button reminder-send-button" onClick={() => pendingCount ? setReminderConfirmation("email") : setReminderMessage("You are all caught up. Add a pending assignment to email a reminder.")} disabled={!isOnline || !user.emailVerified || emailReminderSending}>{emailReminderSending ? "Sending…" : "Email me"}</button>
              </div>
              <p className="reminder-sound-note">Email reminders go to your verified account address. Device alerts require permission; iPhone and iPad require CampusOS on the Home Screen.</p>
              <p className="reminder-sound-note">Reminder sound is {soundEnabled ? "on" : "muted"}. Toggle the bell to change it.</p>
            </section>
          </>
        )}
        {reminderConfirmation && (
          <div className="reminder-confirm-backdrop" onClick={() => setReminderConfirmation(null)}>
            <section className="reminder-confirm-dialog liquid-glass" role="dialog" aria-modal="true" aria-labelledby="reminder-confirm-title" aria-describedby="reminder-confirm-description" onClick={(event) => event.stopPropagation()}>
              <span className="reminder-confirm-icon" aria-hidden="true">{reminderConfirmation === "desktop" ? "⌁" : "✉"}</span>
              <p className="profile-kicker">CAMPUSOS REMINDERS</p>
              <h2 id="reminder-confirm-title">{reminderConfirmation === "desktop" ? "Send reminders to this device?" : "Email your reminders?"}</h2>
              <p id="reminder-confirm-description">
                {reminderConfirmation === "desktop"
                  ? pendingCount
                    ? `Send ${pendingCount} pending assignment reminder${pendingCount === 1 ? "" : "s"} as desktop notifications on this device. Your browser may ask for notification permission.`
                    : "Allow CampusOS to show notifications on this device. You can send reminders here when you have pending assignments."
                  : `Send up to ${Math.min(pendingCount, 20)} pending assignment reminder${pendingCount === 1 ? "" : "s"} to your verified account email, ${user.email}.`}
              </p>
              <div className="reminder-confirm-actions">
                <button ref={reminderCancelRef} className="reminder-confirm-cancel" onClick={() => setReminderConfirmation(null)}>Cancel</button>
                <button className="primary-button reminder-confirm-send" onClick={() => {
                  const action = reminderConfirmation;
                  setReminderConfirmation(null);
                  if (action === "desktop") void sendDesktopReminders();
                  else void emailPendingReminders();
                }} disabled={reminderConfirmation === "email" && (!isOnline || !user.email || !user.emailVerified || emailReminderSending)}>
                  {reminderConfirmation === "desktop" ? pendingCount ? "Send to device" : "Enable notifications" : "Send email"}
                </button>
              </div>
            </section>
          </div>
        )}
        {timetableReminderRequest && (
          <div className="timetable-reminder-backdrop" onMouseDown={(event) => { if (!timetableReminderBusy && event.target === event.currentTarget) setTimetableReminderRequest(null); }}>
            <section className="timetable-reminder-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="timetable-reminder-title" aria-describedby="timetable-reminder-description">
              <span className="reminder-confirm-icon" aria-hidden="true">◷</span>
              <p className="profile-kicker">TIMETABLE REMINDER</p>
              <h2 id="timetable-reminder-title">{timetableReminders.some((item) => item.sourceType === timetableReminderRequest.type && item.sourceId === timetableReminderRequest.entry.id) ? "Update this notification reminder?" : "Add this to notification reminders?"}</h2>
              <p id="timetable-reminder-description">{timetableReminderRequest.type === "weekly" ? <><strong>{courses.find((course) => course.code === timetableReminderRequest.entry.courseCode)?.name ?? timetableReminderRequest.entry.courseCode}</strong> · Every {timetableReminderRequest.entry.day} at {timetableReminderRequest.entry.start}</> : <><strong>{timetableReminderRequest.entry.title}</strong> · {timetableReminderRequest.entry.courseCode} · {timetableReminderRequest.entry.date} at {timetableReminderRequest.entry.start}{timetableReminderRequest.entry.location ? ` · ${timetableReminderRequest.entry.location}` : ""}</>}<br />CampusOS will send a device notification before it starts, including when the app is closed where supported.</p>
              <label className="timetable-reminder-lead">Remind me
                <select value={timetableReminderLead} onChange={(event) => setTimetableReminderLead(Number(event.target.value))}>
                  <option value={5}>5 minutes before</option><option value={15}>15 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option>
                </select>
              </label>
              <div className="reminder-confirm-actions">
                <button type="button" className="reminder-confirm-cancel" disabled={timetableReminderBusy} onClick={() => setTimetableReminderRequest(null)}>Cancel</button>
                <button type="button" className="primary-button reminder-confirm-send" disabled={timetableReminderBusy} onClick={() => void confirmAddTimetableReminder()}>{timetableReminderBusy ? "Saving reminder…" : "Confirm reminder"}</button>
              </div>
            </section>
          </div>
        )}
        {timetableReminderRemovalRequest && (
          <div className="timetable-reminder-backdrop" onMouseDown={(event) => { if (!timetableReminderRemovalBusy && event.target === event.currentTarget) setTimetableReminderRemovalRequest(null); }}>
            <section className="timetable-reminder-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="timetable-reminder-removal-title" aria-describedby="timetable-reminder-removal-description">
              <span className="reminder-confirm-icon timetable-removal-icon" aria-hidden="true">◷</span>
              <p className="profile-kicker">TIMETABLE REMINDER</p>
              <h2 id="timetable-reminder-removal-title">Remove this notification reminder?</h2>
              <p id="timetable-reminder-removal-description">{timetableReminderRemovalRequest.type === "weekly" ? <><strong>{courses.find((course) => course.code === timetableReminderRemovalRequest.entry.courseCode)?.name ?? timetableReminderRemovalRequest.entry.courseCode}</strong> · Every {timetableReminderRemovalRequest.entry.day} at {timetableReminderRemovalRequest.entry.start}</> : <><strong>{timetableReminderRemovalRequest.entry.title}</strong> · {timetableReminderRemovalRequest.entry.courseCode} · {timetableReminderRemovalRequest.entry.date} at {timetableReminderRemovalRequest.entry.start}{timetableReminderRemovalRequest.entry.location ? ` · ${timetableReminderRemovalRequest.entry.location}` : ""}</>}<br />The notification reminder for this timetable entry will be removed from your subscribed devices.</p>
              <div className="reminder-confirm-actions">
                <button type="button" className="reminder-confirm-cancel" disabled={timetableReminderRemovalBusy} onClick={() => setTimetableReminderRemovalRequest(null)}>Keep reminder</button>
                <button type="button" className="timetable-reminder-remove-confirm" disabled={timetableReminderRemovalBusy} onClick={() => void confirmTimetableReminderRemoval()}>{timetableReminderRemovalBusy ? "Removing…" : "Remove reminder"}</button>
              </div>
            </section>
          </div>
        )}
        {assignmentReminderRequest && (
          <div className="timetable-reminder-backdrop" onMouseDown={(event) => { if (!assignmentReminderBusy && event.target === event.currentTarget) setAssignmentReminderRequest(null); }}>
            <section className="timetable-reminder-dialog assignment-reminder-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="assignment-reminder-title" aria-describedby="assignment-reminder-description">
              <span className="reminder-confirm-icon" aria-hidden="true">◷</span>
              <p className="profile-kicker">ASSIGNMENT REMINDER</p>
              <h2 id="assignment-reminder-title">{assignmentReminders.some((item) => item.assignmentId === assignmentReminderRequest.id) ? "Update this notification reminder?" : "Add this assignment to notification reminders?"}</h2>
              <p id="assignment-reminder-description"><strong>{assignmentReminderRequest.title}</strong> · {assignmentReminderRequest.course}<br />CampusOS will send a push notification to this account’s subscribed devices before the deadline, including when the app is closed where supported.</p>
              {!assignmentReminderRequest.dueDate && <p className="reminder-message">This assignment was saved without an exact year. Choose the correct due date to schedule its reminder.</p>}
              <label className="timetable-reminder-lead">Assignment due date
                <input type="date" value={assignmentReminderDate} onChange={(event) => setAssignmentReminderDate(event.target.value)} required />
              </label>
              <label className="timetable-reminder-lead">Due time
                <input type="time" value={assignmentReminderTime} onChange={(event) => setAssignmentReminderTime(event.target.value)} required />
              </label>
              <label className="timetable-reminder-lead">Remind me
                <select value={assignmentReminderLead} onChange={(event) => setAssignmentReminderLead(Number(event.target.value))}>
                  <option value={15}>15 minutes before</option><option value={60}>1 hour before</option><option value={1440}>1 day before</option>
                </select>
              </label>
              <div className="reminder-confirm-actions">
                <button type="button" className="reminder-confirm-cancel" disabled={assignmentReminderBusy} onClick={() => setAssignmentReminderRequest(null)}>Cancel</button>
                <button type="button" className="primary-button reminder-confirm-send" disabled={assignmentReminderBusy || !assignmentReminderDate} onClick={() => void confirmAssignmentReminder()}>{assignmentReminderBusy ? "Saving reminder…" : "Confirm reminder"}</button>
              </div>
            </section>
          </div>
        )}
        {assignmentReminderRemovalRequest && (
          <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!assignmentReminderRemovalBusy && event.target === event.currentTarget) setAssignmentReminderRemovalRequest(null); }}>
            <section className="attachment-delete-dialog liquid-glass assignment-reminder-removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="assignment-reminder-removal-title" aria-describedby="assignment-reminder-removal-description">
              <div className="attachment-delete-icon" aria-hidden="true">◷</div>
              <p className="profile-kicker">ASSIGNMENT REMINDER</p>
              <h2 id="assignment-reminder-removal-title">Remove this notification reminder?</h2>
              <p id="assignment-reminder-removal-description">The reminder for <strong>{assignmentReminderRemovalRequest.title}</strong> · {assignmentReminderRemovalRequest.course} will stop being sent to your subscribed devices.</p>
              <div className="attachment-delete-actions">
                <button type="button" className="attachment-delete-cancel" disabled={assignmentReminderRemovalBusy} onClick={() => setAssignmentReminderRemovalRequest(null)}>Keep reminder</button>
                <button type="button" className="attachment-delete-confirm" disabled={assignmentReminderRemovalBusy} onClick={() => void confirmAssignmentReminderRemoval()}>{assignmentReminderRemovalBusy ? "Removing…" : "Remove reminder"}</button>
              </div>
            </section>
          </div>
        )}
        {courseDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!courseDeleteBusy && event.target === event.currentTarget) setCourseDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="course-delete-title" aria-describedby="course-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">COURSE REMOVAL</p><h2 id="course-delete-title">Delete this course?</h2><p id="course-delete-description"><strong>{courseDeleteRequest.code} · {courseDeleteRequest.name}</strong> and its linked weekly and exam timetable entries will be removed. Assignment records will remain in your list.</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={courseDeleteBusy} onClick={() => setCourseDeleteRequest(null)}>Keep course</button><button type="button" className="attachment-delete-confirm" disabled={courseDeleteBusy} onClick={() => void confirmCourseDelete()}>{courseDeleteBusy ? "Deleting…" : "Delete course"}</button></div></section></div>}
        {assignmentDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!assignmentDeleteBusy && event.target === event.currentTarget) setAssignmentDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="assignment-delete-title" aria-describedby="assignment-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">ASSIGNMENT REMOVAL</p><h2 id="assignment-delete-title">Delete this assignment?</h2><p id="assignment-delete-description"><strong>{assignmentDeleteRequest.title}</strong> will be removed from your assignment list and deleted from this device and account.</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={assignmentDeleteBusy} onClick={() => setAssignmentDeleteRequest(null)}>Keep assignment</button><button type="button" className="attachment-delete-confirm" disabled={assignmentDeleteBusy} onClick={() => void confirmAssignmentDelete()}>{assignmentDeleteBusy ? "Deleting…" : "Delete assignment"}</button></div></section></div>}
        {timetableDeleteRequest && <div className="attachment-delete-backdrop" onMouseDown={(event) => { if (!timetableDeleteBusy && event.target === event.currentTarget) setTimetableDeleteRequest(null); }}><section className="attachment-delete-dialog liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="timetable-delete-title" aria-describedby="timetable-delete-description"><div className="attachment-delete-icon" aria-hidden="true">⌫</div><p className="profile-kicker">TIMETABLE REMOVAL</p><h2 id="timetable-delete-title">Delete this timetable entry?</h2><p id="timetable-delete-description">{timetableDeleteRequest.type === "weekly" ? <><strong>{timetableDeleteRequest.entry.courseCode}</strong> · {timetableDeleteRequest.entry.day}, {timetableDeleteRequest.entry.start}–{timetableDeleteRequest.entry.end} will be removed from your weekly timetable.</> : <><strong>{timetableDeleteRequest.entry.title}</strong> · {timetableDeleteRequest.entry.courseCode}, {timetableDeleteRequest.entry.date} at {timetableDeleteRequest.entry.start} will be removed from your exam timetable.</>}</p><div className="attachment-delete-actions"><button type="button" className="attachment-delete-cancel" disabled={timetableDeleteBusy} onClick={() => setTimetableDeleteRequest(null)}>Keep entry</button><button type="button" className="attachment-delete-confirm" disabled={timetableDeleteBusy} onClick={() => void confirmTimetableDelete()}>{timetableDeleteBusy ? "Deleting…" : "Delete timetable"}</button></div></section></div>}
        {profileOpen && <Suspense fallback={<div className="profile-loading liquid-glass" role="status">Loading profile…</div>}><ProfilePanel studentUid={user.uid} registeredEmail={user.email ?? ""} courses={courses} studentName={studentName} onNameChange={updateStudentName} onChangePassword={changeStudentPassword} onSignOut={onSignOut} onSignOutOtherSessions={signOutOtherSessions} onClose={() => setProfileOpen(false)} /></Suspense>}
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
                onClick={() => { resetAssignmentForm(); setShowForm(true); }}
              >
                <span>＋</span> Add assignment
              </button>
            )}
          </section>

          {showForm && (
            <section className="panel form-panel liquid-glass assignment-entry-panel">
              <div className="section-heading">
                <div>
                  <h2>New assignment</h2>
                  <p>Add an assignment to your academic planner.</p>
                </div>
                <button
                  className="close-button"
                  onClick={() => { resetAssignmentForm(); setShowForm(false); }}
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
                  Assignment description
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

                <label>
                  Student ID / matriculation number
                  <input value={studentMatriculationNo} readOnly aria-readonly="true" />
                </label>

                <label>
                  Completion status
                  <select value={newAssignmentCompleted ? "completed" : "not-completed"} onChange={(event) => setNewAssignmentCompleted(event.target.value === "completed")}>
                    <option value="not-completed">Not completed</option>
                    <option value="completed">Completed</option>
                  </select>
                </label>

                <p className="assignment-id-note">A unique assignment ID and creation date are added automatically when you save.</p>

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
                      <div className="assignment-row" key={assignment.id} data-search-id={assignment.id}>
                        <button
                          className={`checkbox ${assignment.completed ? "checked" : ""}`}
                          onClick={() => void setAssignmentCompletion(assignment.id, !assignment.completed)}
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
                <button className="primary-button" onClick={startNewCourse}>
                  <span>＋</span> Add course
                </button>
              </div>
              {showCourseForm && (
                <form className="assignment-form course-form" onSubmit={saveCourse}>
                  <label>Course code<input value={newCourseCode} onChange={(event) => setNewCourseCode(event.target.value)} placeholder="e.g. BIO 104" required /></label>
                  <label>Course name<input value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="e.g. Introductory Biology" required /></label>
                  <div className="course-credit-field" ref={courseCreditPickerRef}>
                    <span>Course credit units</span>
                    <button type="button" className="course-credit-trigger liquid-glass" aria-haspopup="dialog" aria-expanded={showCourseCredits} onClick={() => setShowCourseCredits((open) => !open)}>
                      <span>{newCourseCreditUnits} {newCourseCreditUnits === 1 ? "credit unit" : "credit units"}</span><span aria-hidden="true">⌄</span>
                    </button>
                    {showCourseCredits && <div className="course-credit-popover liquid-glass" role="dialog" aria-label="Select course credit units">
                      <strong>Select course credits</strong>
                      <div className="course-credit-options" role="group" aria-label="Credit units from 1 to 5">
                        {[1, 2, 3, 4, 5].map((units) => <button key={units} type="button" className={newCourseCreditUnits === units ? "selected" : ""} aria-pressed={newCourseCreditUnits === units} onClick={() => { setNewCourseCreditUnits(units); setShowCourseCredits(false); }}><strong>{units}</strong><span>{units === 1 ? "unit" : "units"}</span></button>)}
                      </div>
                    </div>}
                  </div>
                  <button className="primary-button" type="submit">{editingCourseCode ? "Save changes" : "Save course"}</button>
                  {newCourseCode.trim() && courses.some((course) => course.code === newCourseCode.trim().toUpperCase() && course.code !== editingCourseCode) && <p className="form-error">A course with this code already exists.</p>}
                </form>
              )}
              <div className="course-grid">
                {courses.map((course) => (
                  <article className="course-card" key={course.code} data-search-id={course.code}>
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
                    <span className="course-credit-badge">{course.creditUnits ? `${course.creditUnits} ${course.creditUnits === 1 ? "credit" : "credits"}` : "Credits not set"}</span>
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
                  <form className="assignment-form assignment-edit-form liquid-glass" key={assignment.id} onSubmit={saveAssignmentEdit}>
                    <label>Assignment title<input value={assignmentDraft.title} onChange={(event) => setAssignmentDraft((current) => ({ ...current, title: event.target.value }))} required /></label>
                    <label>Assignment description<textarea value={assignmentDraft.question} onChange={(event) => setAssignmentDraft((current) => ({ ...current, question: event.target.value }))} rows={4} required /></label>
                    <label>Course<select value={assignmentDraft.course} onChange={(event) => setAssignmentDraft((current) => ({ ...current, course: event.target.value }))} required>{courses.map((course) => <option key={course.code} value={course.code}>{course.code} — {course.name}</option>)}</select></label>
                    <label>Due date<input type="date" value={assignmentDraft.due} onChange={(event) => setAssignmentDraft((current) => ({ ...current, due: event.target.value }))} required /></label>
                    <label>Student ID / matriculation number<input value={assignment.studentId || studentMatriculationNo} readOnly aria-readonly="true" /></label>
                    <div className="assignment-edit-actions"><button className="primary-button" type="submit">Save changes</button><button className="profile-cancel" type="button" onClick={() => setEditingAssignmentId(null)}>Cancel</button></div>
                  </form>
                ) : (
                  <div className="assignment-row assignment-manager-row" key={assignment.id} data-search-id={assignment.id}>
                    <div className="assignment-info">
                      <strong className={assignment.completed ? "completed-title" : ""}>{assignment.title}</strong>
                      <span>Course: {assignment.course} · Assignment ID: {assignment.id}</span>
                      {(assignment.description || assignment.question) && <p className="assignment-question">{assignment.description || assignment.question}</p>}
                      <div className="assignment-record-details"><span>Student ID: {assignment.studentId || "Not provided"}</span><span>Created: {formatAssignmentDate(assignment.createdAt)}</span></div>
                    </div>
                    <div className="assignment-status-column"><span className="assignment-deadline">Due {assignment.due}</span><label className={`assignment-status-select ${assignment.completed ? "is-complete" : ""}`}><span className="sr-only">Completion status for {assignment.title}</span><select value={assignment.completed ? "completed" : "not-completed"} onChange={(event) => void setAssignmentCompletion(assignment.id, event.target.value === "completed")}><option value="not-completed">Not completed</option><option value="completed">Completed</option></select></label></div>
                    <div className="course-menu-wrap task-menu-wrap">
                      <button className="course-menu-button" aria-label={`Options for ${assignment.title}`} aria-expanded={openCourseMenu === `assignment-${assignment.id}`} onClick={(event) => {
                        const hasReminder = assignmentReminders.some((item) => item.assignmentId === assignment.id);
                        const coarse = window.matchMedia("(pointer: coarse)").matches;
                        toggleAssignmentMenu(event, assignment.id, `assignment-${assignment.id}`, coarse ? (hasReminder ? 188 : 144) : (hasReminder ? 154 : 120));
                      }}>⋯</button>
                      {openCourseMenu === `assignment-${assignment.id}` && assignmentMenuPosition && createPortal(<div className="course-menu task-menu task-menu-portal" role="menu" style={assignmentMenuPosition}>
                        <button type="button" role="menuitem" onClick={() => openAssignmentReminder(assignment)}>{assignmentReminders.some((item) => item.assignmentId === assignment.id) ? "Update notification reminder" : "Add to notification reminder"}</button>
                        {assignmentReminders.some((item) => item.assignmentId === assignment.id) && <button type="button" role="menuitem" onClick={() => requestAssignmentReminderRemoval(assignment)}>Remove notification reminder</button>}
                        <button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); beginEditAssignment(assignment); }}>Edit task</button>
                        <button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); void removeAssignment(assignment.id); }}>Delete task</button>
                      </div>, document.body)}
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
            <section className={`panel timetable-panel ${openCourseMenu?.startsWith("schedule-") ? "schedule-menu-open" : ""}`}>
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
                  const hasReminder = timetableReminders.some((item) => item.sourceType === "weekly" && item.sourceId === schedule.id);
                  return (
                    <div className="lecture-row" key={schedule.id} data-search-id={schedule.id}>
                      <span className="lecture-day">{schedule.day.slice(0, 3).toUpperCase()}</span>
                      <div className="lecture-info">
                        <strong>{course?.name ?? schedule.courseCode}</strong>
                        <span>{schedule.start} – {schedule.end} · {schedule.courseCode}</span>
                      </div>
                      <div className="course-menu-wrap">
                        <button className="course-menu-button" aria-label={`Options for ${schedule.courseCode} schedule`} aria-expanded={openCourseMenu === `schedule-${schedule.id}`} onClick={() => setOpenCourseMenu((current) => current === `schedule-${schedule.id}` ? null : `schedule-${schedule.id}`)}>⋯</button>
                        {openCourseMenu === `schedule-${schedule.id}` && <div className="course-menu"><button onClick={() => openTimetableReminder({ type: "weekly", entry: schedule })}>{hasReminder ? "Edit notification reminder" : "Add to notification reminder"}</button>{hasReminder && <button onClick={() => requestTimetableReminderRemoval({ type: "weekly", entry: schedule })}>Remove notification reminder</button>}<button onClick={() => beginEditSchedule(schedule)}>Edit schedule</button><button onClick={() => void removeSchedule(schedule.id)}>Delete schedule</button><button onClick={() => beginEditCourse(schedule.courseCode)}>Edit course</button><button onClick={() => void removeCourse(schedule.courseCode)}>Delete course</button></div>}
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
                  const hasReminder = timetableReminders.some((item) => item.sourceType === "exam" && item.sourceId === exam.id);
                  const daysAway = Math.ceil((examDate.getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
                  const dateLabel = Number.isNaN(examDate.getTime()) ? exam.date : examDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
                  return <article className="exam-row" key={exam.id} data-search-id={exam.id}>
                    <div className="exam-date-tile"><strong>{Number.isNaN(examDate.getTime()) ? "—" : examDate.getDate()}</strong><span>{Number.isNaN(examDate.getTime()) ? "" : examDate.toLocaleDateString("en-GB", { month: "short" })}</span></div>
                    <div className="exam-info"><strong>{exam.title}</strong><span>{exam.courseCode} · {dateLabel} · {exam.start}</span><span className="exam-location">{exam.location}</span></div>
                    <span className={`exam-countdown ${daysAway < 0 ? "exam-past" : ""}`}>{daysAway < 0 ? "Past" : daysAway === 0 ? "Today" : daysAway === 1 ? "Tomorrow" : `${daysAway} days`}</span>
                    <div className="course-menu-wrap task-menu-wrap"><button className="course-menu-button" aria-label={`Options for ${exam.title}`} aria-expanded={openCourseMenu === `exam-${exam.id}`} onClick={(event) => toggleAssignmentMenu(event, exam.id, `exam-${exam.id}`, window.matchMedia("(pointer: coarse)").matches ? (hasReminder ? 280 : 240) : (hasReminder ? 248 : 208))}>⋯</button>
                      {openCourseMenu === `exam-${exam.id}` && assignmentMenuPosition && createPortal(<div className="course-menu task-menu task-menu-portal" role="menu" style={assignmentMenuPosition}><button type="button" role="menuitem" onClick={() => openTimetableReminder({ type: "exam", entry: exam })}>{hasReminder ? "Edit notification reminder" : "Add to notification reminder"}</button>{hasReminder && <button type="button" role="menuitem" onClick={() => requestTimetableReminderRemoval({ type: "exam", entry: exam })}>Remove notification reminder</button>}<button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); beginEditExam(exam); }}>Edit schedule</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); void removeExam(exam.id); }}>Delete schedule</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); beginEditCourse(exam.courseCode); }}>Edit course</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); void removeCourse(exam.courseCode); }}>Delete course</button></div>, document.body)}
                    </div>
                  </article>;
                })}
                {exams.length === 0 && <p className="empty-state">No exams added yet. Add an upcoming examination to keep its date and venue handy.</p>}
              </div>
            </section>
            </>
          )}

          {["Notes & Resources", "Grade Calculator", "Cloud Database", "Backup & Recovery"].includes(activePage) && <Suspense fallback={<section className="panel study-loading" role="status">Loading study tools…</section>}><StudyTools
            page={activePage}
            searchTargetId={activePage === "Notes & Resources" ? searchTargetId : null}
            studentUid={user.uid}
            connected={cloudConnected && isOnline}
            online={isOnline}
            syncPending={queuedWriteCount > 0}
            cloudMessage={cloudMessage}
            recordCounts={{ courses: courses.length, assignments: assignments.length, schedules: schedules.length, exams: exams.length }}
          /></Suspense>}

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
  const [verifiedUserUid, setVerifiedUserUid] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!firebaseConfigured);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    const auth = firebaseAuth;
    if (!auth) {
      setAuthReady(true);
      return;
    }
    return onIdTokenChanged(auth, (currentUser) => {
      setUser(currentUser);
      setVerifiedUserUid(currentUser?.emailVerified ? currentUser.uid : null);
      setAuthReady(true);
    }, () => {
      setAuthError("We could not check your sign-in session. Please try again.");
      setAuthReady(true);
    });
  }, []);

  const emailActionMode = new URLSearchParams(window.location.search).get("mode");
  const isEmailAction = ["verifyEmail", "resetPassword", "recoverEmail", "verifyAndChangeEmail"].includes(emailActionMode ?? "");
  if (isEmailAction) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Opening secure account link…</section></main>}><EmailActionScreen /></Suspense>;
  if (!authReady) return <main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Checking your secure session…</section></main>;
  if (authError) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Opening sign in…</section></main>}><AuthScreen initialError={authError} /></Suspense>;
  if (!user) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Opening sign in…</section></main>}><AuthScreen /></Suspense>;
  if (!user.emailVerified && verifiedUserUid !== user.uid) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Loading verification…</section></main>}><VerificationScreen user={user} onVerified={setVerifiedUserUid} /></Suspense>;
  return <CampusOSWorkspace key={user.uid} user={user} onSignOut={() => firebaseAuth ? signOut(firebaseAuth) : Promise.resolve()} />;
}

export default App;
