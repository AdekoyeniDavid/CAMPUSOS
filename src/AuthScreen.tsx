import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  applyActionCode,
  verifyPasswordResetCode,
  confirmPasswordReset,
  getIdToken,
  reload,
  signOut,
  type User,
  updateProfile,
} from "firebase/auth";
import { firebaseAuth, getFirestoreDb } from "./firebase";
import { readStoredValue, removeStoredValue, writeStoredValue } from "./browser";

type Mode = "signin" | "register" | "reset";
const pendingVerificationStorageKey = "campusos-pending-email-verification";
const verificationEmailRequests = new Map<string, Promise<boolean>>();

/** Send a verified action link that returns the user to the same CampusOS origin. */
function sendVerificationLink(user: User): Promise<boolean> {
  const existing = verificationEmailRequests.get(user.uid);
  if (existing) return existing;

  const request = (async () => {
    if (firebaseAuth && typeof navigator !== "undefined" && navigator.language) {
      firebaseAuth.languageCode = navigator.language;
    }
    const actionCodeSettings = {
      url: new URL("/?campusosVerify=1", window.location.origin).toString(),
      handleCodeInApp: false,
    };
    try {
      await sendEmailVerification(user, actionCodeSettings);
      return true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      // Keep verification available if the app's domain has not yet been authorized in Firebase.
      if (!code.includes("unauthorized-continue-uri") && !code.includes("invalid-continue-uri")) throw error;
      await sendEmailVerification(user);
      return false;
    }
  })();
  verificationEmailRequests.set(user.uid, request);
  void request.then(
    () => { if (verificationEmailRequests.get(user.uid) === request) verificationEmailRequests.delete(user.uid); },
    () => { if (verificationEmailRequests.get(user.uid) === request) verificationEmailRequests.delete(user.uid); },
  );
  return request;
}

function verificationSendError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code.includes("operation-not-allowed")) return "Email verification is disabled in Firebase Authentication. Enable Email/Password sign-in in the Firebase console, then try again.";
  if (code.includes("too-many-requests")) return "Firebase temporarily limited verification emails. Wait a few minutes, then choose Resend verification email.";
  if (code.includes("network-request-failed")) return "The verification email could not be reached. Check your internet connection and try again.";
  if (code.includes("unauthorized-continue-uri") || code.includes("invalid-continue-uri")) return "Firebase could not create the verification link. Add this site's domain to Firebase Authentication's authorized domains, then resend.";
  return "We could not send the verification email. Check your connection and use Resend verification email to try again.";
}

function readableAuthError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("email-already-in-use")) return "An account already uses this email. Try signing in instead.";
  if (code.includes("weak-password")) return "Choose a stronger password with at least 8 characters.";
  if (code.includes("invalid-credential") || code.includes("user-not-found") || code.includes("wrong-password")) return "The email or password is incorrect.";
  if (code.includes("too-many-requests")) return "Too many attempts. Wait a little while and try again.";
  if (code.includes("network-request-failed")) return "Connection unavailable. Check your internet connection and try again.";
  return "We could not complete that request. Please try again.";
}

export function AuthScreen({ initialError = "" }: { initialError?: string }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(() => mode === "signin" ? readStoredValue("campusos-remembered-email") ?? "" : "");
  const [rememberMe, setRememberMe] = useState(() => readStoredValue("campusos-remember-me") === "true");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(initialError);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const autoSignInStarted = useRef(false);

  async function signIn(emailValue: string, passwordValue: string) {
    if (!firebaseAuth || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    // Load Firestore's client bundle while Firebase signs the user in.
    void getFirestoreDb().catch(() => null);
    try {
      await setPersistence(firebaseAuth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(firebaseAuth, emailValue.trim(), passwordValue);
      if (rememberMe) {
        writeStoredValue("campusos-remember-me", "true");
        writeStoredValue("campusos-remembered-email", emailValue.trim());
      } else {
        removeStoredValue("campusos-remember-me");
        removeStoredValue("campusos-remembered-email");
      }
    } catch (caught) {
      setError(readableAuthError(caught));
      autoSignInStarted.current = false;
    } finally {
      setBusy(false);
    }
  }

  function tryAutofillSignIn() {
    if (mode !== "signin" || busy || autoSignInStarted.current) return;
    const emailElement = emailInput.current;
    const passwordElement = passwordInput.current;
    if (!emailElement || !passwordElement) return;
    let passwordWasAutofilled = false;
    try { passwordWasAutofilled = passwordElement.matches(":-webkit-autofill"); } catch { /* selector is browser-specific */ }
    const emailValue = emailElement.value;
    const passwordValue = passwordElement.value;
    if (passwordWasAutofilled && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue) && passwordValue.length >= 8) {
      autoSignInStarted.current = true;
      setEmail(emailValue);
      setPassword(passwordValue);
      void signIn(emailValue, passwordValue);
    }
  }

  useEffect(() => {
    if (mode !== "signin") return;
    const scheduleCheck = () => {
      window.setTimeout(tryAutofillSignIn, 120);
      window.setTimeout(tryAutofillSignIn, 500);
    };
    document.addEventListener("visibilitychange", scheduleCheck);
    window.addEventListener("pageshow", scheduleCheck);
    return () => {
      document.removeEventListener("visibilitychange", scheduleCheck);
      window.removeEventListener("pageshow", scheduleCheck);
    };
  }, [mode, busy, rememberMe]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!firebaseAuth) {
      setError("Firebase is not configured for this app yet.");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    if (mode !== "reset" && password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "register") {
        // Mark the account creation before Firebase signs the user in and switches screens.
        writeStoredValue(pendingVerificationStorageKey, "pending");
        let credential;
        try {
          credential = await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
        } catch (caught) {
          removeStoredValue(pendingVerificationStorageKey);
          throw caught;
        }
        await updateProfile(credential.user, { displayName: fullName.trim() }).catch(() => undefined);
      } else if (mode === "signin") {
        // Warm the database client during auth so the workspace can attach its live listeners immediately.
        void getFirestoreDb().catch(() => null);
        await setPersistence(firebaseAuth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
        await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
        if (rememberMe) {
          writeStoredValue("campusos-remember-me", "true");
          writeStoredValue("campusos-remembered-email", email.trim());
        } else {
          removeStoredValue("campusos-remember-me");
          removeStoredValue("campusos-remembered-email");
        }
      } else {
        await sendPasswordResetEmail(firebaseAuth, email.trim());
        setMessage("If an account exists for that address, a password reset link has been sent.");
      }
    } catch (caught) {
      setError(readableAuthError(caught));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setError("");
    setMessage("");
  }

  return <main className="auth-screen">
    <div className="auth-brand"><span className="brand-icon">C</span><span>Campus<span className="brand-light">OS</span></span></div>
    <section className="auth-card liquid-glass">
      <p className="profile-kicker">STUDENT WORKSPACE</p>
      <h1>{mode === "register" ? "Create your account" : mode === "reset" ? "Reset your password" : "Welcome back"}</h1>
      <p className="auth-subtitle">{mode === "register" ? "Register with your email to get started." : mode === "reset" ? "We’ll send a secure reset link to your email." : "Sign in to continue to CampusOS."}</p>
      {!firebaseAuth && <div className="auth-notice" role="status">Add the Firebase project settings from <code>.env.example</code> to enable accounts. Then enable Email/Password in Firebase Authentication.</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="auth-notice" role="status">{message}</div>}
      <form className="auth-form" onSubmit={submit}>
        {mode === "register" && <label>Full name<input type="text" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} required disabled={busy} /></label>}
        <label>Email address<input ref={emailInput} type="email" autoComplete="email" value={email} onFocus={() => window.setTimeout(tryAutofillSignIn, 120)} onInput={tryAutofillSignIn} onAnimationStart={tryAutofillSignIn} onChange={(event) => setEmail(event.target.value)} required disabled={busy} /></label>
        {mode !== "reset" && <label>Password<div className="auth-password-wrap"><input ref={mode === "signin" ? passwordInput : undefined} type={showPassword ? "text" : "password"} autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={8} value={password} onFocus={() => window.setTimeout(tryAutofillSignIn, 120)} onInput={tryAutofillSignIn} onAnimationStart={tryAutofillSignIn} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /><button className="password-visibility-toggle liquid-glass" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} disabled={busy}>{showPassword ? "Hide" : "Show"}</button></div></label>}
        {mode === "signin" && <label className="remember-me-option"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} disabled={busy} /><span>Remember me</span></label>}
        {mode === "register" && <label>Confirm password<div className="auth-password-wrap"><input type={showConfirmPassword ? "text" : "password"} autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required disabled={busy} /><button className="password-visibility-toggle liquid-glass" type="button" onClick={() => setShowConfirmPassword((visible) => !visible)} aria-label={showConfirmPassword ? "Hide confirmation password" : "Show confirmation password"} aria-pressed={showConfirmPassword} disabled={busy}>{showConfirmPassword ? "Hide" : "Show"}</button></div></label>}
        <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "register" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}</button>
      </form>
      <div className="auth-links">
        {mode === "signin" && <><button onClick={() => switchMode("reset")}>Forgot password?</button><span>New to CampusOS?</span><button onClick={() => switchMode("register")}>Create an account</button></>}
        {mode === "register" && <><span>Already have an account?</span><button onClick={() => switchMode("signin")}>Sign in</button></>}
        {mode === "reset" && <button onClick={() => switchMode("signin")}>Back to sign in</button>}
      </div>
      <p className="auth-session-note">{rememberMe ? "You’ll stay signed in on this device until you sign out." : "You’ll stay signed in for this browser session. Your password is never saved."}</p>
    </section>
  </main>;
}

export { readableAuthError };


/** Completes Firebase email verification on the app's own domain. */
export function EmailActionScreen() {
  const [mode, setMode] = useState("");
  const [status, setStatus] = useState<"working" | "reset-ready" | "success" | "error">("working");
  const [message, setMessage] = useState("Opening your secure account link…");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const actionCode = useRef("");
  const actionStarted = useRef(false);

  useEffect(() => {
    if (actionStarted.current) return;
    actionStarted.current = true;

    const url = new URL(window.location.href);
    const actionMode = url.searchParams.get("mode") ?? "";
    const oobCode = url.searchParams.get("oobCode") ?? "";
    const auth = firebaseAuth;
    // Remove one-time credentials from the address bar and browser history immediately.
    url.searchParams.delete("oobCode");
    url.searchParams.delete("apiKey");
    url.searchParams.delete("mode");
    url.searchParams.delete("continueUrl");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);

    setMode(actionMode);
    actionCode.current = oobCode;
    if (!actionCode.current || !auth) {
      setStatus("error");
      setMessage("This account link is incomplete or unavailable. Request a new email and open its latest link.");
      return;
    }

    const runAction = async () => {
      if (actionMode === "resetPassword") {
        const address = await verifyPasswordResetCode(auth, actionCode.current);
        setEmail(address);
        setStatus("reset-ready");
        setMessage("Choose a new password for your CampusOS account.");
        return;
      }
      if (!["verifyEmail", "recoverEmail", "verifyAndChangeEmail"].includes(actionMode)) {
        throw new Error("unsupported-action");
      }
      await applyActionCode(auth, actionCode.current);
      setStatus("success");
      setMessage(actionMode === "verifyEmail"
        ? "Your email is verified. Continue to CampusOS and sign in to open your account."
        : actionMode === "recoverEmail"
          ? "Your previous email address has been restored. Continue to CampusOS to sign in."
          : "Your email address has been updated. Continue to CampusOS to sign in.");
    };
    void runAction().catch((error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      setStatus("error");
      setMessage(code.includes("expired-action-code") || code.includes("invalid-action-code")
        ? "This account link has expired or was already used. Request a new email and open the latest link."
        : "We couldn’t complete this account link. Check your connection and try again.");
    });
  }, []);

  async function saveNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebaseAuth || password.length < 8 || password !== confirmPassword) {
      setMessage(password !== confirmPassword ? "The passwords do not match." : "Choose a password with at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await confirmPasswordReset(firebaseAuth, actionCode.current, password);
      setStatus("success");
      setMessage("Your password has been changed. Continue to CampusOS and sign in with the new password.");
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      setStatus("error");
      setMessage(code.includes("expired-action-code") || code.includes("invalid-action-code")
        ? "This password reset link has expired or was already used. Request a new password reset email."
        : "We couldn’t change the password. Check the requirements and try again.");
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === "resetPassword" ? "Reset your password"
    : mode === "recoverEmail" ? "Restore your email"
      : mode === "verifyAndChangeEmail" ? "Update your email"
        : status === "success" ? "Email verified"
          : status === "error" ? "Account link issue" : "Verifying your email";

  return <main className="auth-screen">
    <div className="auth-brand"><span className="brand-icon">C</span><span>Campus<span className="brand-light">OS</span></span></div>
    <section className="auth-card liquid-glass" aria-live="polite">
      <p className="profile-kicker">CAMPUSOS ACCOUNT</p>
      <h1>{heading}</h1>
      {status !== "reset-ready" && <p className={status === "error" ? "auth-error" : "auth-notice"} role={status === "error" ? "alert" : "status"}>{message}</p>}
      {status === "reset-ready" && <>
        <p className="auth-subtitle">Resetting password for <strong>{email}</strong>.</p>
        <form className="auth-form" onSubmit={(event) => void saveNewPassword(event)}>
          <label>New password<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required disabled={busy} /></label>
          <p className="auth-notice" role="status">{message}</p>
          <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? "Updating password…" : "Save new password"}</button>
        </form>
      </>}
      {(status === "success" || status === "error") && <button className="primary-button auth-submit" onClick={() => window.location.replace("/")}>Continue to CampusOS</button>}
    </section>
  </main>;
}

export function VerificationScreen({ user, onVerified }: { user: User; onVerified: (uid: string) => void }) {
  const [message, setMessage] = useState(() => readStoredValue(pendingVerificationStorageKey) === "pending" ? "Sending a verification link to your email…" : "");
  const [busy, setBusy] = useState(false);
  const verificationCheckInFlight = useRef(false);
  const appWasAway = useRef(false);

  useEffect(() => {
    if (readStoredValue(pendingVerificationStorageKey) !== "pending") return;
    let active = true;
    setBusy(true);
    void sendVerificationLink(user).then((hasAppReturnLink) => {
      removeStoredValue(pendingVerificationStorageKey);
      if (!active) return;
      setMessage(hasAppReturnLink
        ? "Verification link sent. Open it from your email to verify your account and return to CampusOS."
        : "Verification email sent. Firebase has not authorized this site's return link yet, so after verifying, come back here and choose “I’ve verified my email”.");
    }).catch((error: unknown) => {
      removeStoredValue(pendingVerificationStorageKey);
      if (active) setMessage(verificationSendError(error));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [user.uid]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("campusosVerify") !== "1") return;
    url.searchParams.delete("campusosVerify");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    void checkVerified();
  }, [user.uid]);

  useEffect(() => {
    const checkWhenReturning = () => {
      if (document.visibilityState === "hidden") {
        appWasAway.current = true;
        return;
      }
      if (!appWasAway.current) return;
      appWasAway.current = false;
      void checkVerified();
    };
    document.addEventListener("visibilitychange", checkWhenReturning);
    window.addEventListener("focus", checkWhenReturning);
    window.addEventListener("pageshow", checkWhenReturning);
    return () => {
      document.removeEventListener("visibilitychange", checkWhenReturning);
      window.removeEventListener("focus", checkWhenReturning);
      window.removeEventListener("pageshow", checkWhenReturning);
    };
  }, [user.uid]);

  async function resend() {
    if (!firebaseAuth) return;
    setBusy(true);
    setMessage("");
    try {
      const hasAppReturnLink = await sendVerificationLink(user);
      setMessage(hasAppReturnLink
        ? "A new verification link has been sent. Check your inbox and spam folder."
        : "A new verification email has been sent. Firebase has not authorized this site's return link yet; after verifying, come back here and choose “I’ve verified my email”.");
    } catch (error) {
      setMessage(verificationSendError(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkVerified() {
    if (verificationCheckInFlight.current) return;
    verificationCheckInFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const currentUser = firebaseAuth?.currentUser;
      if (!currentUser || currentUser.uid !== user.uid) {
        setMessage("Your sign-in session changed. Sign in again to continue.");
        return;
      }
      await reload(currentUser);
      if (!currentUser.emailVerified) {
        setMessage("Your email is not verified yet. Open the link in your inbox, then check again.");
        return;
      }
      // Refresh the token so Firestore rules and the workspace see the verified claim too.
      await getIdToken(currentUser, true);
      onVerified(currentUser.uid);
    } catch {
      setMessage("We could not check verification status. Check your connection and try again.");
    } finally {
      verificationCheckInFlight.current = false;
      setBusy(false);
    }
  }

  async function leaveAccount() {
    if (firebaseAuth) await signOut(firebaseAuth);
  }

  return <main className="auth-screen">
    <div className="auth-brand"><span className="brand-icon">C</span><span>Campus<span className="brand-light">OS</span></span></div>
    <section className="auth-card liquid-glass">
      <p className="profile-kicker">VERIFY YOUR EMAIL</p>
      <h1>Check your inbox</h1>
      <p className="auth-subtitle">Verify <strong>{user.email}</strong> using the link in your inbox to open your student workspace. Check your spam folder if it does not arrive.</p>
      {message && <div className="auth-notice" role="status">{message}</div>}
      <button className="primary-button auth-submit" onClick={() => void checkVerified()} disabled={busy}>{busy ? "Checking…" : "I’ve verified my email"}</button>
      <div className="auth-links verification-links"><button onClick={() => void resend()} disabled={busy}>Resend verification email</button><button onClick={() => void leaveAccount()}>Sign out</button></div>
    </section>
  </main>;
}
