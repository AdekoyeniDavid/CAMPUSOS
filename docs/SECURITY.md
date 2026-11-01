# CampusOS security setup

CampusOS uses Firebase Authentication, Firestore, and Storage for student data, with a Cloudflare Worker for the app shell, reminder APIs, and D1-backed delivery queues.

## Controls already in the repository

- Firestore rules require a verified Firebase account, scope student records to the owner, restrict staff access to assigned accounts, validate academic record shapes, and support session revocation.
- Profile sections now validate known fields, field lengths, academic periods, dates, and email format before saving; Firestore rules repeat bounded shape checks at the data boundary.
- Storage rules restrict files to the signed-in owner's private study-material path, require a verified email and an existing student record, limit uploads to 20 MB and approved document MIME types, and block new uploads during account deletion.
- Account deletion reauthenticates the user, locks student writes, then removes account-scoped Firestore documents, private Storage objects, Cloudflare D1 reminder records, Firebase Auth, and local IndexedDB records. The Worker deletes D1 rows using only the UID from a verified Firebase ID token; it accepts no UID or admin credential from the browser.
- The Worker validates Firebase ID-token signatures and claims before reminder operations, bounds request bodies, limits email and push sends per account, validates push-service endpoints, and stores private signing keys in Worker secrets.
- Static app responses use a restrictive Content Security Policy, HSTS, frame protection, MIME sniffing protection, and a limited Permissions Policy. Worker API responses now also include HSTS and the other API security headers.
- The web client now supports Firebase App Check with reCAPTCHA Enterprise when `VITE_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY` is configured. Without the key, existing sign-in and data behavior remains unchanged.

## Enable App Check before enforcing it

1. Create a score-based reCAPTCHA Enterprise web key in Google Cloud. Register the production hostname `campusos.campusos-app.workers.dev`. Use a separate development key for `localhost`; do not add localhost to the production key.
2. In Firebase Console → App Check, register the CampusOS web app with that same Enterprise key.
3. Set `VITE_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY` in the build environment used to produce the production assets. The site key is public configuration, not a secret. For a local build, put it in the ignored `.env` file. Keep development keys separate from production keys.
4. Build and deploy the client, then monitor App Check request metrics for Authentication, Firestore, and Storage. Confirm current browser and installed-PWA versions are sending valid tokens.
5. Enforce App Check for those Firebase products only after the metrics show the active clients are covered. Old cached clients may otherwise lose access until they update. Use Firebase's debug provider only in a local development build and register the debug token in Firebase Console; never ship a debug token.

App Check is intentionally not enforced by code: Firebase enforcement is a project-level setting and should follow a measured rollout to avoid locking out existing users.

## Firebase Console review

- Authentication: keep email verification required for academic data; confirm email-enumeration protection is enabled; configure a password policy and review Identity Toolkit quotas. Test email/password, Google, Apple, password reset, and verification flows after changing settings.
- App Check: register all web app IDs that are actively used, including any separate development app, before enabling enforcement.
- Firestore and Storage: deploy rules from `firestore.rules` and `storage.rules`; never use broad `allow read, write: if true` rules. The Storage rules now check Firestore to block uploads during account deletion. On the first deployment, Firebase prompts you to enable Storage-to-Firestore rules access; approve that integration for the default Firestore database. Review Firebase Rules Playground or Emulator results before changing policy.
- API keys: treat Firebase web configuration as public, but restrict the Firebase API key by allowed website referrers and the APIs CampusOS actually uses. Verify all sign-in providers before tightening API restrictions.
- Project access: remove unused project members and service accounts, use least-privilege roles, and require MFA for administrators.

## Cloudflare review

- Keep `PUSH_VAPID_PRIVATE_KEY`, `RESEND_API_KEY`, and other credentials as Wrangler secrets. Never put them in `vars`, `.env.example`, source files, browser bundles, or chat. The VAPID public key and Firebase web configuration are public values.
- The current production hostname is a `workers.dev` hostname. For a production custom domain, attach a domain managed in the Cloudflare account so zone-level WAF Managed Rules, custom rules, and rate-limiting rules can be applied to the app. Review Security Events after enabling rules and tune them to avoid blocking student traffic.
- Cloudflare Access would make the student site private to a selected identity group, so do not enable it for the public student app unless that is the intended audience.
- Review Worker logs and traces for operational failures, and avoid logging ID tokens, email addresses, push endpoints, or student record contents.

## Account deletion behavior

- The profile's Account & Security section asks the user to type the registered email. Password accounts also require the current password; Google and Apple accounts are asked to reauthenticate with their provider.
- The Worker deletion endpoint requires a verified Firebase ID token and deletes only reminder rows whose `uid` matches its verified subject. Keep the existing D1 migrations applied so all reminder tables exist.
- Firebase rules prevent creating or editing student data after the deletion lock is written. The client deletes child documents before the student document because Firestore does not cascade deletes, then deletes the marker and local device copies.
- If the browser closes or connectivity fails mid-flow, the account remains locked against new edits and the user can sign in again to retry. Do not remove the Auth user before remote cleanup completes.

## Validation

Run `npm run build` for client and Worker validation. Review rule changes with the Firebase Emulator Suite or Rules Playground before deploying. Production deployment and Firebase Console enforcement are separate actions; this repository change does not deploy either one.
