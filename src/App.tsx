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
  revokeOtherSessions as revokeOtherSessionsRecord,
  watchSessionRevocation,
  watchStudentCollection,
  watchStudentDocument,
} from "./firestore";
import { pendingWriteCount, replaceWithRemoteRecords, syncPendingWrites, watchLocalRecords } from "./offlineStore";
import "./App.css";
import { createRecordId, readStoredValue, writeStoredValue } from "./browser";
import { normalizeCourseRecords } from "./courseRecords";

const ProfilePanel = lazy(() => import("./ProfilePanel").then((module) => ({ default: module.ProfilePanel })));
const StudyTools = lazy(() => import("./StudyTools").then((module) => ({ default: module.StudyTools })));
const AuthScreen = lazy(() => import("./AuthScreen").then((module) => ({ default: module.AuthScreen })));
const VerificationScreen = lazy(() => import("./AuthScreen").then((module) => ({ default: module.VerificationScreen })));

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
  description?: string;
  course: string;
  due: string;
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

type StudyMaterial = { id: string; title: string; category: string; content: string; resourceUrl: string };
type QuickSearchResult = { id: string; title: string; detail: string; category: string; page: string; searchable: string };

type ThemeMode = "light" | "dark" | "system";

const initialAssignments: Assignment[] = [];
const initialCourses: Course[] = [];
const initialSchedules: Schedule[] = [];

function getStudentInitials(fullName: string) {
  const initials = fullName.trim().split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase());
  return initials.length ? initials.join(".") : "S";
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
  const [timetableDeleteRequest, setTimetableDeleteRequest] = useState<{ type: "weekly"; entry: Schedule } | { type: "exam"; entry: Exam } | null>(null);
  const [timetableDeleteBusy, setTimetableDeleteBusy] = useState(false);
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
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [newCourse, setNewCourse] = useState("COS 102");
  const [newDue, setNewDue] = useState("");
  const [newAssignmentCompleted, setNewAssignmentCompleted] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updatePreference = () => setSystemPrefersDark(media.matches);
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    writeStoredValue("campusos-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!reminderConfirmation) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReminderConfirmation(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    const focusTimer = window.setTimeout(() => reminderCancelRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.clearTimeout(focusTimer);
    };
  }, [reminderConfirmation]);

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
      else liveParts.add(key);
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
    setShowCourseForm(true);
  }

  function beginEditCourse(code: string) {
    const normalizedCode = code.trim().toUpperCase();
    const course = courses.find((item) => item.code.trim().toUpperCase() === normalizedCode);
    setEditingCourseCode(course?.code ?? null);
    setNewCourseCode(course?.code ?? normalizedCode);
    setNewCourseName(course?.name ?? normalizedCode);
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
      const saved = await persistCloudRecord(() => deleteAssignmentRecord(user.uid, request.id));
      if (saved) setAssignmentDeleteRequest(null);
    } finally {
      setAssignmentDeleteBusy(false);
    }
  }

  async function setAssignmentCompletion(id: string, completed: boolean) {
    const assignment = assignments.find((item) => item.id === id);
    if (!assignment) return;
    await persistCloudRecord(() => saveAssignmentRecord(user.uid, id, { ...assignment, completed, studentId: assignment.studentId ?? studentMatriculationNo }, false));
  }

  function beginEditAssignment(assignment: Assignment) {
    setEditingAssignmentId(assignment.id);
    setAssignmentDraft({ title: assignment.title, question: assignment.description ?? assignment.question, course: assignment.course, due: assignment.due });
    setOpenCourseMenu(null);
  }

  async function saveAssignmentEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAssignmentId || !assignmentDraft.title.trim() || !assignmentDraft.question.trim() || !assignmentDraft.due.trim()) return;
    const existing = assignments.find((item) => item.id === editingAssignmentId);
    const description = assignmentDraft.question.trim();
    const assignment = { ...assignmentDraft, title: assignmentDraft.title.trim(), question: description, description, due: assignmentDraft.due.trim(), completed: existing?.completed ?? false, studentId: existing?.studentId ?? studentMatriculationNo, ...(existing?.createdAt !== undefined ? { createdAt: existing.createdAt } : {}) };
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

    const id = createRecordId();
    const saved = await persistCloudRecord(() => saveAssignmentRecord(user.uid, id, {
      title: newTitle.trim(), question: newQuestion.trim(), description: newQuestion.trim(), course: newCourse, due: formattedDate, completed: newAssignmentCompleted,
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
    try {
      let registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
      if (!registration && "serviceWorker" in navigator) {
        registration = await navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
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
      setReminderMessage(`${pending.length} pending assignment ${pending.length === 1 ? "reminder was" : "reminders were"} sent.`);
    } catch {
      setReminderMessage("The browser could not send reminders. Check notification permissions and try again.");
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
                    <label>Due date<input value={assignmentDraft.due} onChange={(event) => setAssignmentDraft((current) => ({ ...current, due: event.target.value }))} placeholder="e.g. 18 May" required /></label>
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
                      <button className="course-menu-button" aria-label={`Options for ${assignment.title}`} aria-expanded={openCourseMenu === `assignment-${assignment.id}`} onClick={(event) => toggleAssignmentMenu(event, assignment.id)}>⋯</button>
                      {openCourseMenu === `assignment-${assignment.id}` && assignmentMenuPosition && createPortal(<div className="course-menu task-menu task-menu-portal" role="menu" style={assignmentMenuPosition}><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); beginEditAssignment(assignment); }}>Edit task</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); void removeAssignment(assignment.id); }}>Delete task</button></div>, document.body)}
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
                  return (
                    <div className="lecture-row" key={schedule.id} data-search-id={schedule.id}>
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
                  return <article className="exam-row" key={exam.id} data-search-id={exam.id}>
                    <div className="exam-date-tile"><strong>{Number.isNaN(examDate.getTime()) ? "—" : examDate.getDate()}</strong><span>{Number.isNaN(examDate.getTime()) ? "" : examDate.toLocaleDateString("en-GB", { month: "short" })}</span></div>
                    <div className="exam-info"><strong>{exam.title}</strong><span>{exam.courseCode} · {dateLabel} · {exam.start}</span><span className="exam-location">{exam.location}</span></div>
                    <span className={`exam-countdown ${daysAway < 0 ? "exam-past" : ""}`}>{daysAway < 0 ? "Past" : daysAway === 0 ? "Today" : daysAway === 1 ? "Tomorrow" : `${daysAway} days`}</span>
                    <div className="course-menu-wrap task-menu-wrap"><button className="course-menu-button" aria-label={`Options for ${exam.title}`} aria-expanded={openCourseMenu === `exam-${exam.id}`} onClick={(event) => toggleAssignmentMenu(event, exam.id, `exam-${exam.id}`, window.matchMedia("(pointer: coarse)").matches ? 196 : 170)}>⋯</button>
                      {openCourseMenu === `exam-${exam.id}` && assignmentMenuPosition && createPortal(<div className="course-menu task-menu task-menu-portal" role="menu" style={assignmentMenuPosition}><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); beginEditExam(exam); }}>Edit schedule</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); void removeExam(exam.id); }}>Delete schedule</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); beginEditCourse(exam.courseCode); }}>Edit course</button><button type="button" role="menuitem" onClick={() => { setAssignmentMenuPosition(null); void removeCourse(exam.courseCode); }}>Delete course</button></div>, document.body)}
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
      setAuthReady(true);
    }, () => {
      setAuthError("We could not check your sign-in session. Please try again.");
      setAuthReady(true);
    });
  }, []);

  if (!authReady) return <main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Checking your secure session…</section></main>;
  if (authError) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Opening sign in…</section></main>}><AuthScreen initialError={authError} /></Suspense>;
  if (!user) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Opening sign in…</section></main>}><AuthScreen /></Suspense>;
  if (!user.emailVerified) return <Suspense fallback={<main className="auth-screen"><section className="auth-card liquid-glass auth-loading">Loading verification…</section></main>}><VerificationScreen user={user} /></Suspense>;
  return <CampusOSWorkspace key={user.uid} user={user} onSignOut={() => firebaseAuth ? signOut(firebaseAuth) : Promise.resolve()} />;
}

export default App;
