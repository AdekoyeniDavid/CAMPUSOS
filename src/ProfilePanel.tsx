import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { firebaseConfigured } from "./firebase";
import { cacheStudentDocument, saveStudentSection, watchStudentDocument } from "./firestore";
import { watchLocalRecords } from "./offlineStore";

type CourseSummary = { code: string; name: string };
type SectionId = "profile" | "institution" | "personal" | "contact" | "academic" | "enrolment" | "courses" | "progress" | "security";
type Values = Record<string, string>;
type ProfileData = Record<Exclude<SectionId, "security">, Values>;

type Field = { key: string; label: string; type?: "text" | "email" | "date" | "tel" | "textarea" | "select"; options?: string[] };

const countryCodes = "AF AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB UM US UY UZ VU VE VN VG VI WF EH YE ZM ZW".split(" ");
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryOptions = countryCodes.map((code) => countryNames.of(code) ?? code).sort((a, b) => a.localeCompare(b));
const genderOptions = ["Male", "Female", "Rather not say"];
const levelOptions = ["100 level", "200 level", "300 level", "400 level", "500 level"];
const enrolmentOptions = ["Not admitted", "Admission in progress", "Admitted"];
const standingOptions = ["Courses not yet approved", "Courses have been approved"];
const notProvided = "Not provided";

const sectionFields: Array<{ id: Exclude<SectionId, "security">; title: string; fields: Field[] }> = [
  { id: "profile", title: "Profile", fields: [{ key: "fullName", label: "Full name" }, { key: "studentId", label: "Student ID" }, { key: "programme", label: "Programme" }] },
  { id: "institution", title: "Institution Details", fields: [{ key: "name", label: "Institution name" }] },
  { id: "personal", title: "Personal Details", fields: [{ key: "dateOfBirth", label: "Date of birth", type: "date" }, { key: "gender", label: "Gender", type: "select", options: genderOptions }, { key: "genderDescription", label: "Exact gender (optional)" }, { key: "nationality", label: "Nationality", type: "select", options: countryOptions }] },
  { id: "contact", title: "Contact Details", fields: [{ key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone number", type: "tel" }, { key: "address", label: "Residential address", type: "textarea" }] },
  { id: "academic", title: "Academic Details", fields: [{ key: "department", label: "College/Faculty" }, { key: "programme", label: "Programme" }, { key: "level", label: "Level", type: "select", options: levelOptions }, { key: "session", label: "Academic session" }, { key: "semester", label: "Semester", type: "select", options: ["First semester", "Second semester", "Extended semester"] }, { key: "programStart", label: "Program start date", type: "date" }, { key: "programEnd", label: "Expected program end date", type: "date" }] },
  { id: "enrolment", title: "Enrolment", fields: [{ key: "admissionDate", label: "Admission date", type: "date" }, { key: "status", label: "Enrolment status", type: "select", options: enrolmentOptions }] },
  { id: "courses", title: "Courses", fields: [{ key: "registeredCourses", label: "Registered courses · code · credit units", type: "textarea" }] },
  { id: "progress", title: "Academic Progress", fields: [{ key: "gpa", label: "GPA" }, { key: "completedCredits", label: "Completed credits" }, { key: "standing", label: "Academic standing", type: "select", options: standingOptions }] },
];

const initialData: ProfileData = {
  profile: { fullName: "Student", studentId: "Not provided", programme: "Not provided" },
  institution: { name: "Not provided" },
  personal: { dateOfBirth: "", gender: "Not provided", genderDescription: "", nationality: "Not provided" },
  contact: { email: "", phone: "", address: "" },
  academic: { department: "Not provided", programme: "Not provided", level: "Not provided", session: "Not provided", semester: "Not provided", programStart: "", programEnd: "" },
  enrolment: { admissionDate: "", status: "Not provided" },
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
      {id !== "courses" && <div className="profile-menu-wrap">
        <button className="profile-menu-trigger" aria-label={`Options for ${title ?? section?.title}`} aria-expanded={menuOpen} onClick={onMenu}>⋯</button>
        {menuOpen && <div className="profile-section-menu"><button onClick={onEdit}>Edit section</button></div>}
      </div>}
    </header>
    {editing ? <form className="profile-edit-form" onSubmit={onSave}>
      {resolvedFields.map((field) => <label key={field.key}>{field.label}
        {field.type === "textarea" ? <textarea value={values[field.key] === notProvided ? "" : values[field.key] ?? ""} placeholder={notProvided} readOnly={id === "courses"} onFocus={() => { if (values[field.key] === notProvided) onChange(field.key, ""); }} onChange={(event) => onChange(field.key, event.target.value)} required={id !== "courses"} rows={field.key === "registeredCourses" ? 4 : 2} /> : field.type === "select" ? <select value={values[field.key] ?? ""} onChange={(event) => onChange(field.key, event.target.value)} required><option value="" disabled>Select {field.label.toLowerCase()}</option>{values[field.key] && !field.options?.includes(values[field.key]) && <option value={values[field.key]}>{values[field.key]}</option>}{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input type={field.type ?? "text"} value={values[field.key] === notProvided ? "" : values[field.key] ?? ""} placeholder={values[field.key] === notProvided ? notProvided : undefined} readOnly={id === "contact" && field.key === "email"} onFocus={() => { if (values[field.key] === notProvided) onChange(field.key, ""); }} onChange={(event) => onChange(field.key, event.target.value)} required={!(["genderDescription", "dateOfBirth", "admissionDate", "programStart", "programEnd"].includes(field.key))} />}
      </label>)}
      {id === "contact" && values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) && <p className="profile-validation">Enter a valid email address.</p>}
      <div className="profile-form-actions"><button className="primary-button" type="submit">Save changes</button><button className="profile-cancel" type="button" onClick={onCancel}>Cancel</button></div>
    </form> : <dl className="profile-fields">{resolvedFields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{values[field.key]?.trim() || "Not provided"}</dd></div>)}</dl>}
  </section>;
}

export function ProfilePanel({ studentUid, registeredEmail, courses, studentName, onNameChange, onChangePassword, onSignOut, onSignOutOtherSessions, onClose }: { studentUid: string; registeredEmail: string; courses: CourseSummary[]; studentName: string; onNameChange: (name: string) => void; onChangePassword: (current: string, next: string) => Promise<void>; onSignOut: () => Promise<void>; onSignOutOtherSessions: () => Promise<void>; onClose: () => void }) {
  const [data, setData] = useState<ProfileData>(() => ({ ...initialData, profile: { ...initialData.profile, fullName: studentName }, contact: { ...initialData.contact, email: registeredEmail }, courses: { registeredCourses: courses.length ? courses.map((course) => `${course.code} — ${course.name} · credit units not provided`).join("\n") : "No courses registered yet." } }));
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [openMenu, setOpenMenu] = useState<SectionId | null>(null);
  const [message, setMessage] = useState("");
  const [securityFormOpen, setSecurityFormOpen] = useState(false);
  const [revokingOtherSessions, setRevokingOtherSessions] = useState(false);
  const [signOutConfirmation, setSignOutConfirmation] = useState<"current" | "others" | null>(null);
  const [passwordFields, setPasswordFields] = useState({ current: "", next: "", confirm: "" });

  useEffect(() => {
    setData((current) => ({ ...current, contact: { ...current.contact, email: registeredEmail }, courses: { registeredCourses: courses.length ? courses.map((course) => `${course.code} — ${course.name} · credit units not provided`).join("\n") : "No courses registered yet." } }));
  }, [registeredEmail, courses]);

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
    const localUnsubscribe = watchLocalRecords(studentUid, "studentSections", (records) => {
      setData((current) => {
        const next = { ...current };
        for (const { id, ...values } of records) {
          if (id in initialData) {
            const sectionId = id as keyof ProfileData;
            next[sectionId] = { ...next[sectionId], ...(values as Values) };
          }
        }
        next.contact = { ...next.contact, email: registeredEmail };
        next.academic = { ...next.academic, programEnd: next.academic.programEnd || next.enrolment.graduation };
        return next;
      });
      const profile = records.find((record) => record.id === "profile");
      if (typeof profile?.["fullName"] === "string" && profile["fullName"].trim()) onNameChange(profile["fullName"]);
    });
    if (!firebaseConfigured) {
      setMessage("Firebase is not configured. Your profile edits are stored on this device only.");
      return localUnsubscribe;
    }
    const remoteUnsubscribe = watchStudentDocument(studentUid, (student, fromCache) => {
      if (!student) return;
      void cacheStudentDocument(studentUid, student, !fromCache);
    }, () => setMessage("Cloud sync is unavailable. Your saved profile remains on this device and will retry when connected."));
    return () => { localUnsubscribe(); remoteUnsubscribe(); };
  }, [studentUid, registeredEmail]);

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
      const sectionValues = id === "contact" ? { ...data.contact, email: registeredEmail } : data[id];
      await saveStudentSection(studentUid, id, sectionValues);
      if (id === "profile") onNameChange(data.profile.fullName);
      setEditing(null);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? `Changes could not be saved locally: ${error.message}` : "Changes could not be saved locally. Check available device storage and retry.");
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

  async function revokeOtherSessions() {
    setRevokingOtherSessions(true);
    setMessage("");
    try {
      await onSignOutOtherSessions();
      setMessage("Other signed-in devices have been signed out. This device stays signed in.");
    } catch {
      setMessage("Other sessions could not be signed out. Check your connection and try again.");
    } finally {
      setRevokingOtherSessions(false);
    }
  }

  async function confirmSignOut() {
    const action = signOutConfirmation;
    setSignOutConfirmation(null);
    if (action === "current") {
      await onSignOut();
    } else if (action === "others") {
      await revokeOtherSessions();
    }
  }

  return <>
    <button className="profile-overlay" aria-label="Close student profile" onClick={onClose} />
    <aside className="profile-panel liquid-glass" aria-label="Student profile" role="dialog" aria-modal="true">
      <header className="profile-panel-header">
        <div className="profile-heading-identity"><div><p className="profile-kicker">STUDENT ACCOUNT</p><h2>{data.profile.fullName}</h2><span>{data.profile.studentId}</span></div></div>
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
          <dl className="profile-fields"><div><dt>Active sessions</dt><dd>This device stays signed in when you revoke other sessions.</dd></div><div><dt>Security settings</dt><dd>Managed by your campus account</dd></div></dl>
          <button className="profile-session-revoke" type="button" onClick={() => setSignOutConfirmation("others")} disabled={revokingOtherSessions}>{revokingOtherSessions ? "Signing out other devices…" : "Sign out of all other sessions"}</button>
          <button className="profile-signout-button" onClick={() => setSignOutConfirmation("current")}>Sign out of this session</button>
          {securityFormOpen && <form className="profile-edit-form" onSubmit={savePassword}><label>Current password<input type="password" autoComplete="current-password" value={passwordFields.current} onChange={(event) => setPasswordFields((current) => ({ ...current, current: event.target.value }))} required /></label><label>New password<input type="password" autoComplete="new-password" value={passwordFields.next} onChange={(event) => setPasswordFields((current) => ({ ...current, next: event.target.value }))} required minLength={8} /></label><label>Confirm new password<input type="password" autoComplete="new-password" value={passwordFields.confirm} onChange={(event) => setPasswordFields((current) => ({ ...current, confirm: event.target.value }))} required /></label><div className="profile-form-actions"><button className="primary-button" type="submit">Update password</button><button className="profile-cancel" type="button" onClick={() => setSecurityFormOpen(false)}>Cancel</button></div></form>}
        </section>
      </div>
      <p className="profile-privacy-note">Student details are stored in Firestore. Each verified student can access their own records; staff access is limited by server-assigned roles and permissions.</p>
    </aside>
    {signOutConfirmation && <div className="signout-confirm-backdrop" onClick={() => setSignOutConfirmation(null)}>
      <section className="signout-confirm liquid-glass" role="alertdialog" aria-modal="true" aria-labelledby="signout-confirm-title" aria-describedby="signout-confirm-description" onClick={(event) => event.stopPropagation()}>
        <div className="signout-confirm-icon" aria-hidden="true">!</div>
        <h3 id="signout-confirm-title">{signOutConfirmation === "current" ? "Sign out of this device?" : "Sign out of other devices?"}</h3>
        <p id="signout-confirm-description">{signOutConfirmation === "current" ? "You will be signed out on this device and need to sign in again to continue." : "All other signed-in devices will be signed out. This device will stay signed in."}</p>
        <div className="signout-confirm-actions">
          <button type="button" className="profile-cancel" onClick={() => setSignOutConfirmation(null)}>Cancel</button>
          <button type="button" className="signout-confirm-submit" onClick={() => void confirmSignOut()}>{signOutConfirmation === "current" ? "Sign out" : "Sign out other devices"}</button>
        </div>
      </section>
    </div>}
  </>;
}
