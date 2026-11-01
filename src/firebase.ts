import { getApp, getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import type { Firestore } from "firebase/firestore";

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env?.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env?.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env?.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID,
  storageBucket: import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET,
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId,
);

const firebaseApp = firebaseConfigured
  ? getApps().length ? getApp() : initializeApp(firebaseConfig)
  : null;

// Optional until the web app is registered in Firebase App Check and its
// reCAPTCHA Enterprise site key is provided by the deployment environment.
// Initialize before Auth/Firestore can issue network requests.
const appCheckSiteKey = import.meta.env?.VITE_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY?.trim();
export const firebaseAppCheckEnabled = Boolean(firebaseApp && appCheckSiteKey);
if (firebaseApp && appCheckSiteKey) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
// Keep Firestore on its native Firebase transport for direct realtime updates.
// The Worker proxy remains opt-in for environments that specifically need it.
const firestoreWorkerHost = import.meta.env?.VITE_USE_FIRESTORE_WORKER_PROXY === "true"
  ? import.meta.env?.VITE_FIRESTORE_WORKER_HOST?.trim()
  : "";
let firestoreDbPromise: Promise<Firestore | null> | undefined;

export function getFirebaseAppInstance() {
  return firebaseApp;
}

export function getFirebaseStorageBucket() {
  return firebaseConfig.storageBucket || "";
}

/** Load Firestore only after a user enters the signed-in workspace. */
export function getFirestoreDb(): Promise<Firestore | null> {
  if (!firebaseApp) return Promise.resolve(null);
  if (!firestoreDbPromise) {
    firestoreDbPromise = import("firebase/firestore").then(({ getFirestore, initializeFirestore }) =>
      firestoreWorkerHost
        ? initializeFirestore(firebaseApp, { host: firestoreWorkerHost, ssl: true })
        : getFirestore(firebaseApp),
    ).catch((error: unknown) => {
      firestoreDbPromise = undefined;
      throw error;
    });
  }
  return firestoreDbPromise;
}
