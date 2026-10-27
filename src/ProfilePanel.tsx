import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { firebaseConfigured } from "./firebase";
import { saveStudentSection } from "./firestore";
import { watchLocalRecords } from "./offlineStore";

type CourseSummary = { code: string; name: string };
type SectionId = "profile" | "institution" | "personal" | "contact" | "academic" | "enrolment" | "courses" | "progress" | "security";
type Values = Record<string, string>;
type ProfileData = Record<Exclude<SectionId, "security">, Values>;

type Field = { key: string; label: string; type?: "text" | "email" | "date" | "tel" | "textarea" | "select"; options?: string[] };

const countryCodes = "AF AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB UM US UY UZ VU VE VN VG VI WF EH YE ZM ZW".split(" ");
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryOptions = countryCodes.map((code) => countryNames.of(code) ?? code).sort((a, b) => a.localeCompare(b));
const callingCodeEntries = "AF=93 AL=355 DZ=213 AS=1 AD=376 AO=244 AI=1 AQ=672 AG=1 AR=54 AM=374 AW=297 AU=61 AT=43 AZ=994 BS=1 BH=973 BD=880 BB=1 BY=375 BE=32 BZ=501 BJ=229 BM=1 BT=975 BO=591 BQ=599 BA=387 BW=267 BV=47 BR=55 IO=246 BN=673 BG=359 BF=226 BI=257 CV=238 KH=855 CM=237 CA=1 KY=1 CF=236 TD=235 CL=56 CN=86 CX=61 CC=61 CO=57 KM=269 CG=242 CD=243 CK=682 CR=506 CI=225 HR=385 CU=53 CW=599 CY=357 CZ=420 DK=45 DJ=253 DM=1 DO=1 EC=593 EG=20 SV=503 GQ=240 ER=291 EE=372 SZ=268 ET=251 FK=500 FO=298 FJ=679 FI=358 FR=33 GF=594 PF=689 TF=262 GA=241 GM=220 GE=995 DE=49 GH=233 GI=350 GR=30 GL=299 GD=1 GP=590 GU=1 GT=502 GG=44 GN=224 GW=245 GY=592 HT=509 HM=672 VA=39 HN=504 HK=852 HU=36 IS=354 IN=91 ID=62 IR=98 IQ=964 IE=353 IM=44 IL=972 IT=39 JM=1 JP=81 JE=44 JO=962 KZ=7 KE=254 KI=686 KP=850 KR=82 KW=965 KG=996 LA=856 LV=371 LB=961 LS=266 LR=231 LY=218 LI=423 LT=370 LU=352 MO=853 MG=261 MW=265 MY=60 MV=960 ML=223 MT=356 MH=692 MQ=596 MR=222 MU=230 YT=262 MX=52 FM=691 MD=373 MC=377 MN=976 ME=382 MS=1 MA=212 MZ=258 MM=95 NA=264 NR=674 NP=977 NL=31 NC=687 NZ=64 NI=505 NE=227 NG=234 NU=683 NF=672 MK=389 MP=1 NO=47 OM=968 PK=92 PW=680 PS=970 PA=507 PG=675 PY=595 PE=51 PH=63 PN=64 PL=48 PT=351 PR=1 QA=974 RE=262 RO=40 RU=7 RW=250 BL=590 SH=290 KN=1 LC=1 MF=590 PM=508 VC=1 WS=685 SM=378 ST=239 SA=966 SN=221 RS=381 SC=248 SL=232 SG=65 SX=1 SK=421 SI=386 SB=677 SO=252 ZA=27 GS=500 SS=211 ES=34 LK=94 SD=249 SR=597 SJ=47 SE=46 CH=41 SY=963 TW=886 TJ=992 TZ=255 TH=66 TL=670 TG=228 TK=690 TO=676 TT=1 TN=216 TR=90 TM=993 TC=1 TV=688 UG=256 UA=380 AE=971 GB=44 UM=1 US=1 UY=598 UZ=998 VU=678 VE=58 VN=84 VG=1 VI=1 WF=681 EH=212 YE=967 ZM=260 ZW=263".split(" ").map((entry) => entry.split("="));
const callingCodes = Object.fromEntries(callingCodeEntries);
const phoneCountryOptions = countryCodes.map((code) => ({ code, name: countryNames.of(code) ?? code, callingCode: callingCodes[code] ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
function phoneNationalNumber(values: Values) {
  const phone = values.phone?.trim() ?? "";
  if (phone === notProvided) return "";
  const prefix = `+${callingCodes[values.phoneCountryCode] ?? ""}`;
  return prefix !== "+" && phone.startsWith(prefix) ? phone.slice(prefix.length).replace(/^\s*[-().]?\s*/, "") : phone;
}

function phoneDisplayNumber(values: Values) {
  const phone = values.phone?.trim() ?? "";
  if (!phone || phone === notProvided || phone.startsWith("+")) return phone === notProvided ? "" : phone;
  const callingCode = callingCodes[values.phoneCountryCode];
  return callingCode ? `+${callingCode} ${phone}` : phone;
}

const deviceRegionCode = (() => {
  if (typeof navigator === "undefined") return "";
  try {
    const region = new Intl.Locale(navigator.language).region;
    return region && countryCodes.includes(region) ? region : "";
  } catch {
    return "";
  }
})();
const deviceRegionNationality = deviceRegionCode ? countryNames.of(deviceRegionCode) ?? "" : "";
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
  personal: { dateOfBirth: "", gender: "Not provided", genderDescription: "", nationality: deviceRegionNationality || "Not provided" },
  contact: { email: "", phoneCountryCode: deviceRegionCode, phone: "", address: "" },
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
  const visibleFields = resolvedFields.filter((field) => !(id === "personal" && field.key === "genderDescription" && values.gender !== "Rather not say"));
  return <section className={`profile-card liquid-glass profile-section-${id}`}>
    <header className="profile-card-heading">
      <h3>{title ?? section?.title}</h3>
      {id !== "courses" && <div className="profile-menu-wrap">
        <button className="profile-menu-trigger" aria-label={`Options for ${title ?? section?.title}`} aria-expanded={menuOpen} onClick={onMenu}>⋯</button>
        {menuOpen && <div className="profile-section-menu"><button onClick={onEdit}>Edit section</button></div>}
      </div>}
    </header>
    {editing ? <form className="profile-edit-form" onSubmit={onSave}>
      {visibleFields.map((field) => <label className={field.key === "genderDescription" ? "gender-description-field" : undefined} key={field.key}>{field.label}
        {field.key === "phone" && id === "contact" ? <div className="phone-number-field"><select className="phone-country-code" aria-label="Country calling code" value={values.phoneCountryCode ?? ""} onChange={(event) => onChange("phoneCountryCode", event.target.value)} required><option value="" disabled>Select country code</option>{phoneCountryOptions.map((country) => <option key={country.code} value={country.code}>+{country.callingCode} · {country.name}</option>)}</select><input type="tel" aria-label="Phone number" autoComplete="tel-national" inputMode="tel" value={phoneNationalNumber(values)} onFocus={() => { if (values.phone === notProvided) onChange("phone", ""); }} onChange={(event) => onChange("phone", event.target.value)} placeholder="Phone number" required /></div> : field.type === "textarea" ? <textarea value={values[field.key] === notProvided ? "" : values[field.key] ?? ""} placeholder={notProvided} readOnly={id === "courses"} onFocus={() => { if (values[field.key] === notProvided) onChange(field.key, ""); }} onChange={(event) => onChange(field.key, event.target.value)} required={id !== "courses"} rows={field.key === "registeredCourses" ? 4 : 2} /> : field.type === "select" ? <select value={values[field.key] ?? ""} onChange={(event) => { onChange(field.key, event.target.value); if (id === "personal" && field.key === "gender" && event.target.value !== "Rather not say") onChange("genderDescription", ""); }} required><option value="" disabled>Select {field.label.toLowerCase()}</option>{values[field.key] && !field.options?.includes(values[field.key]) && <option value={values[field.key]}>{values[field.key]}</option>}{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input type={field.type ?? "text"} value={values[field.key] === notProvided ? "" : values[field.key] ?? ""} placeholder={values[field.key] === notProvided ? notProvided : undefined} readOnly={id === "contact" && field.key === "email"} onFocus={() => { if (values[field.key] === notProvided) onChange(field.key, ""); }} onChange={(event) => onChange(field.key, event.target.value)} required={!(["genderDescription", "dateOfBirth", "admissionDate", "programStart", "programEnd"].includes(field.key))} />}
      </label>)}
      {id === "contact" && values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) && <p className="profile-validation">Enter a valid email address.</p>}
      <div className="profile-form-actions"><button className="primary-button" type="submit">Save changes</button><button className="profile-cancel" type="button" onClick={onCancel}>Cancel</button></div>
    </form> : <dl className="profile-fields">{visibleFields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.key === "phone" ? phoneDisplayNumber(values) || "Not provided" : values[field.key]?.trim() || "Not provided"}</dd></div>)}</dl>}
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
  const [installPrompt, setInstallPrompt] = useState<{ prompt: () => Promise<{ outcome: "accepted" | "dismissed" }>; } | null>(null);
  const [installMessage, setInstallMessage] = useState("");
  const [isInstalled, setIsInstalled] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true));

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as Event & { prompt: () => Promise<{ outcome: "accepted" | "dismissed" }> });
    };
    const installed = () => { setIsInstalled(true); setInstallPrompt(null); setInstallMessage("CampusOS is installed on this device."); };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", installed);
    return () => { window.removeEventListener("beforeinstallprompt", captureInstallPrompt); window.removeEventListener("appinstalled", installed); };
  }, []);

  async function installCampusOS() {
    if (installPrompt) {
      const result = await installPrompt.prompt();
      setInstallPrompt(null);
      if (result.outcome === "accepted") { setIsInstalled(true); setInstallMessage("CampusOS was added to your device."); }
      else setInstallMessage("Installation was cancelled. You can install CampusOS later from your browser menu.");
      return;
    }
    const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    setInstallMessage(isAppleMobile ? "In Safari, tap Share, then Add to Home Screen. Open the installed CampusOS app to enable web push notifications." : "Use your browser’s Install app or Add to Home Screen option to install CampusOS.");
  }

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
        if (!next.contact.phoneCountryCode || next.contact.phoneCountryCode === notProvided) next.contact.phoneCountryCode = deviceRegionCode;
        if (!next.personal.nationality || next.personal.nationality === notProvided) next.personal = { ...next.personal, nationality: deviceRegionNationality || notProvided };
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
    setMessage("");
    return localUnsubscribe;
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
      const sectionValues = id === "contact" ? { ...data.contact, email: registeredEmail, phone: phoneNationalNumber(data.contact) } : data[id];
      await saveStudentSection(studentUid, id, sectionValues);
      if (id === "contact") setData((current) => ({ ...current, contact: { ...current.contact, phone: phoneNationalNumber(data.contact) } }));
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
          <div className="profile-install-card liquid-glass"><div><strong>CampusOS on this device</strong><p>Install CampusOS for a home screen shortcut and eligible background reminders.</p></div><button className="primary-button" type="button" onClick={() => void installCampusOS()} disabled={isInstalled}>{isInstalled ? "Installed" : "Install CampusOS"}</button>{installMessage && <p className="profile-install-message" role="status">{installMessage}</p>}</div>
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
