import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { firestoreDb } from "./firebase";
import { saveStudentSection } from "./firestore";

type CourseSummary = { code: string; name: string };
type SectionId = "profile" | "institution" | "personal" | "contact" | "academic" | "enrolment" | "courses" | "progress" | "security";
type Values = Record<string, string>;
type ProfileData = Record<Exclude<SectionId, "security">, Values>;

type Field = { key: string; label: string; type?: "text" | "email" | "date" | "tel" | "textarea" };

const sectionFields: Array<{ id: Exclude<SectionId, "security">; title: string; fields: Field[] }> = [
  { id: "profile", title: "Profile", fields: [{ key: "fullName", label: "Full name" }, { key: "studentId", label: "Student ID" }, { key: "programme", label: "Programme" }, { key: "photo", label: "Student photo" }] },
  { id: "institution", title: "Institution Details", fields: [{ key: "name", label: "Institution name" }] },
  { id: "personal", title: "Personal Details", fields: [{ key: "dateOfBirth", label: "Date of birth", type: "date" }, { key: "gender", label: "Gender" }, { key: "nationality", label: "Nationality" }] },
  { id: "contact", title: "Contact Details", fields: [{ key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone number", type: "tel" }, { key: "address", label: "Residential address", type: "textarea" }] },
  { id: "academic", title: "Academic Details", fields: [{ key: "department", label: "Department" }, { key: "programme", label: "Programme" }, { key: "level", label: "Level" }, { key: "session", label: "Academic session" }] },
  { id: "enrolment", title: "Enrolment", fields: [{ key: "admissionDate", label: "Admission date", type: "date" }, { key: "status", label: "Enrolment status" }, { key: "graduation", label: "Expected graduation", type: "date" }] },
  { id: "courses", title: "Courses", fields: [{ key: "registeredCourses", label: "Registered courses · code · credit units", type: "textarea" }] },
  { id: "progress", title: "Academic Progress", fields: [{ key: "gpa", label: "GPA" }, { key: "completedCredits", label: "Completed credits" }, { key: "standing", label: "Academic standing" }] },
];

const initialData: ProfileData = {
  profile: { fullName: "Student", studentId: "Not provided", programme: "Not provided", photo: "No photo uploaded" },
  institution: { name: "Not provided" },
  personal: { dateOfBirth: "Not provided", gender: "Not provided", nationality: "Not provided" },
  contact: { email: "", phone: "", address: "" },
  academic: { department: "Not provided", programme: "Not provided", level: "Not provided", session: "Not provided" },
  enrolment: { admissionDate: "", status: "Not provided", graduation: "" },
  courses: { registeredCourses: "" },
  progress: { gpa: "Not provided", completedCredits: "Not provided", standing: "Not provided" },
};

function ProfileInformation({ values, editing, menuOpen, onMenu, onEdit, onChange, onSave, onCancel }: SectionProps) {
  return <ProfileSection title="Profile" {...{ id: "profile", values, editing, menuOpen, onMenu, onEdit, onChange, onSave, onCancel }} />;
}

function ContactDetails(props: SectionProps) {
  return <ProfileSection title="Contact Details" {...props} />;
}

function AcademicRecords({ onProps }: { onProps: (id: Exclude<SectionId, "security">) => SectionProps }) {
  return <>
    <ProfileSection title="Institution Details" {...onProps("institution")} />
    <ProfileSection title="Academic Details" {...onProps("academic")} />
    <ProfileSection title="Enrolment" {...onProps("enrolment")} />
    <ProfileSection title="Courses" {...onProps("courses")} />
    <ProfileSection title="Academic Progress" {...onProps("progress")} />
  </>;
}

type SectionProps = {
  id: Exclude<SectionId, "security">;
  title?: string;
  fields?: Field[];
  values: Values;
  editing: boolean;
  menuOpen: boolean;
  onMenu: () => void;
  onEdit: () => void;
  onChange: (key: string, value: string) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function ProfileSection({ id, title, fields, values, editing, menuOpen, onMenu, onEdit, onChange, onSave, onCancel }: SectionProps) {
  const section = sectionFields.find((item) => item.id === id);
  const resolvedFields = fields ?? section?.fields ?? [];
  return <section className={`profile-card liquid-glass profile-section-${id}`}>
    <header className="profile-card-heading">
      <h3>{title ?? section?.title}</h3>
      <div className="profile-menu-wrap">
        <button className="profile-menu-trigger" aria-label={`Options for ${title ?? section?.title}`} aria-expanded={menuOpen} onClick={onMenu}>⋯</button>
        {menuOpen && <div className="profile-section-menu"><button onClick={onEdit}>Edit section</button></div>}
      </div>
    </header>
    {editing ? <form className="profile-edit-form" onSubmit={onSave}>
      {resolvedFields.map((field) => <label key={field.key}>{field.label}
        {field.type === "textarea" ? <textarea value={values[field.key] ?? ""} onChange={(event) => onChange(field.key, event.target.value)} required rows={field.key === "registeredCourses" ? 4 : 2} /> : <input type={field.type ?? "text"} value={values[field.key] ?? ""} onChange={(event) => onChange(field.key, event.target.value)} required={!["photo", "dateOfBirth", "admissionDate", "graduation"].includes(field.key)} />}
      </label>)}
      {id === "contact" && values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) && <p className="profile-validation">Enter a valid email address.</p>}
      <div className="profile-form-actions"><button className="primary-button" type="submit">Save changes</button><button className="profile-cancel" type="button" onClick={onCancel}>Cancel</button></div>
    </form> : <dl className="profile-fields">{resolvedFields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{values[field.key]?.trim() || "Not provided"}</dd></div>)}</dl>}
  </section>;
}

export function ProfilePanel({ studentUid, courses, studentName, onNameChange, onChangePassword, onSignOut, onClose }: { studentUid: string; courses: CourseSummary[]; studentName: string; onNameChange: (name: string) => void; onChangePassword: (current: string, next: string) => Promise<void>; onSignOut: () => Promise<void>; onClose: () => void }) {
  const [data, setData] = useState<ProfileData>(() => ({ ...initialData, profile: { ...initialData.profile, fullName: studentName }, courses: { registeredCourses: courses.map((course) => `${course.code} — ${course.name} · credit units not provided`).join("\n") } }));
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [openMenu, setOpenMenu] = useState<SectionId | null>(null);
  const [message, setMessage] = useState("");
  const [securityFormOpen, setSecurityFormOpen] = useState(false);
  const [passwordFields, setPasswordFields] = useState({ current: "", next: "", confirm: "" });

  useEffect(() => {
    if (!openMenu) return;
    const closeSectionMenuOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".profile-menu-wrap")) return;
      setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeSectionMenuOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeSectionMenuOnOutsideClick);
  }, [openMenu]);

  useEffect(() => {
    if (!firestoreDb) {
      setMessage("Cloud profile storage is unavailable until Firebase is configured.");
      return;
    }
    return onSnapshot(doc(firestoreDb, "students", studentUid), (snapshot) => {
      if (!snapshot.exists()) return;
      const result = snapshot.data() as Partial<ProfileData>;
      setData((current) => ({
        ...current,
        ...result,
        profile: { ...current.profile, ...result.profile },
        institution: { ...current.institution, ...result.institution },
        personal: { ...current.personal, ...result.personal },
        contact: { ...current.contact, ...result.contact },
        academic: { ...current.academic, ...result.academic },
        enrolment: { ...current.enrolment, ...result.enrolment },
        courses: { ...current.courses, ...result.courses },
        progress: { ...current.progress, ...result.progress },
      }));
      if (result.profile?.fullName) onNameChange(result.profile.fullName);
    }, () => setMessage("Profile data could not sync from Firestore. Check your connection and try again."));
  }, [studentUid]);

  function propsFor(id: Exclude<SectionId, "security">): SectionProps {
    return {
      id, values: data[id], editing: editing === id, menuOpen: openMenu === id,
      onMenu: () => setOpenMenu((current) => current === id ? null : id),
      onEdit: () => { setEditing(id); setOpenMenu(null); setMessage(""); },
      onChange: (key, value) => setData((current) => ({ ...current, [id]: { ...current[id], [key]: value } })),
      onSave: (event) => { void saveSection(event, id); },
      onCancel: () => setEditing(null),
    };
  }

  async function saveSection(event: FormEvent<HTMLFormElement>, id: Exclude<SectionId, "security">) {
    event.preventDefault();
    if (id === "contact" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contact.email)) {
      setMessage("Enter a valid email address before saving.");
      return;
    }
    try {
      await saveStudentSection(studentUid, id, data[id]);
      if (id === "profile") onNameChange(data.profile.fullName);
      setEditing(null);
      setMessage("Changes saved to your secure student record.");
    } catch {
      setMessage("Changes could not be saved to Firestore. Check your connection and try again.");
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordFields.next.length < 8) { setMessage("Choose a password with at least 8 characters."); return; }
    if (passwordFields.next !== passwordFields.confirm) { setMessage("The new passwords do not match."); return; }
    try {
      await onChangePassword(passwordFields.current, passwordFields.next);
      setMessage("Password updated.");
      setPasswordFields({ current: "", next: "", confirm: "" });
      setSecurityFormOpen(false);
    } catch {
      setMessage("Password could not be changed. Sign in again if your session has expired, then retry.");
    }
  }

  return <>
    <button className="profile-overlay" aria-label="Close student profile" onClick={onClose} />
    <aside className="profile-panel liquid-glass" aria-label="Student profile" role="dialog" aria-modal="true">
      <header className="profile-panel-header">
        <div className="profile-heading-identity"><div className="student-photo-placeholder" aria-label="Student photo">{data.profile.photo.startsWith("https://") || data.profile.photo.startsWith("http://") ? <img src={data.profile.photo} alt="Student" /> : data.profile.fullName.trim().charAt(0).toUpperCase() || "S"}</div><div><p className="profile-kicker">STUDENT ACCOUNT</p><h2>{data.profile.fullName}</h2><span>{data.profile.studentId}</span></div></div>
        <button className="profile-close" aria-label="Close profile" onClick={onClose}>×</button>
      </header>
      {message && <div className="profile-notice" role="status">{message}</div>}
      <div className="profile-grid">
        <ProfileInformation {...propsFor("profile")} />
        <ProfileSection title="Personal Details" {...propsFor("personal")} />
        <ContactDetails {...propsFor("contact")} />
        <AcademicRecords onProps={propsFor} />
        <section className="profile-card liquid-glass profile-section-security">
          <header className="profile-card-heading"><h3>Account &amp; Security</h3><div className="profile-menu-wrap"><button className="profile-menu-trigger" aria-label="Account security options" aria-expanded={openMenu === "security"} onClick={() => setOpenMenu((current) => current === "security" ? null : "security")}>⋯</button>{openMenu === "security" && <div className="profile-section-menu"><button onClick={() => { setSecurityFormOpen(true); setOpenMenu(null); }}>Edit security</button></div>}</div></header>
          <dl className="profile-fields"><div><dt>Active sessions</dt><dd>Current browser session</dd></div><div><dt>Security settings</dt><dd>Managed by your campus account</dd></div></dl>
          <button className="profile-signout-button" onClick={() => void onSignOut()}>Sign out of this session</button>
          {securityFormOpen && <form className="profile-edit-form" onSubmit={savePassword}><label>Current password<input type="password" autoComplete="current-password" value={passwordFields.current} onChange={(event) => setPasswordFields((current) => ({ ...current, current: event.target.value }))} required /></label><label>New password<input type="password" autoComplete="new-password" value={passwordFields.next} onChange={(event) => setPasswordFields((current) => ({ ...current, next: event.target.value }))} required minLength={8} /></label><label>Confirm new password<input type="password" autoComplete="new-password" value={passwordFields.confirm} onChange={(event) => setPasswordFields((current) => ({ ...current, confirm: event.target.value }))} required /></label><div className="profile-form-actions"><button className="primary-button" type="submit">Update password</button><button className="profile-cancel" type="button" onClick={() => setSecurityFormOpen(false)}>Cancel</button></div></form>}
        </section>
      </div>
      <p className="profile-privacy-note">Student details are stored in Firestore. Each verified student can access their own records; staff access is limited by server-assigned roles and permissions.</p>
    </aside>
  </>;
}
