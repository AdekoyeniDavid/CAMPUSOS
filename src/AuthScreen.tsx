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
  getIdToken,
  reload,
  signOut,
  type User,
  updateProfile,
} from "firebase/auth";
import { firebaseAuth } from "./firebase";
import { readStoredValue, removeStoredValue, writeStoredValue } from "./browser";

type Mode = "signin" | "register" | "reset";

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
        const credential = await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
        await updateProfile(credential.user, { displayName: fullName.trim() });
        await sendEmailVerification(credential.user);
        setMessage("Account created. Check your email for a verification link before continuing.");
      } else if (mode === "signin") {
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
        {mode !== "reset" && <label>Password<input ref={mode === "signin" ? passwordInput : undefined} type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={8} value={password} onFocus={() => window.setTimeout(tryAutofillSignIn, 120)} onInput={tryAutofillSignIn} onAnimationStart={tryAutofillSignIn} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>}
        {mode === "signin" && <label className="remember-me-option"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} disabled={busy} /><span>Remember me</span></label>}
        {mode === "register" && <label>Confirm password<input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required disabled={busy} /></label>}
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


export function VerificationScreen({ user }: { user: User }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function resend() {
    if (!firebaseAuth) return;
    setBusy(true);
    setMessage("");
    try {
      await sendEmailVerification(user);
      setMessage("A new verification link has been sent. Check your inbox and spam folder.");
    } catch {
      setMessage("We could not send the verification email. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkVerified() {
    setBusy(true);
    setMessage("");
    try {
      await reload(user);
      await getIdToken(user, true);
      if (!user.emailVerified) setMessage("Your email is not verified yet. Open the link in your inbox, then check again.");
    } catch {
      setMessage("We could not check verification status. Check your connection and try again.");
    } finally {
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
      <p className="auth-subtitle">We sent a verification link to <strong>{user.email}</strong>. Verify your email to open your student workspace.</p>
      {message && <div className="auth-notice" role="status">{message}</div>}
      <button className="primary-button auth-submit" onClick={() => void checkVerified()} disabled={busy}>{busy ? "Checking…" : "I’ve verified my email"}</button>
      <div className="auth-links verification-links"><button onClick={() => void resend()} disabled={busy}>Resend verification email</button><button onClick={() => void leaveAccount()}>Sign out</button></div>
    </section>
  </main>;
}
