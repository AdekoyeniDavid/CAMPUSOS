# CampusOS

CampusOS is a student dashboard built with React, TypeScript, and Vite.

## Firebase setup

This checkout is configured for Firebase project `campusos-f5cfc`; its web app is registered, Firebase Authentication **Email/Password** is enabled, and Firestore is provisioned in `africa-south1` (Johannesburg). The local `.env` contains the Firebase web configuration and is ignored by Git. `localhost` is already an authorized domain for development.

For another checkout, copy `.env.example` to `.env`, fill in the Firebase Web app values, enable Email/Password in **Authentication → Sign-in method**, and restart the development server. Firebase web configuration is intended to be used by client apps; never put service account credentials in `.env`.

Students can register with their name, email, and password, verify their email, sign in, request a password reset, and sign out. The sign-in “Remember me” choice controls whether the session persists across browser restarts; the workspace keeps that Firebase setting instead of overriding it. Firebase verification and password-reset messages use the templates configured in the Firebase console.

### Email verification links

CampusOS includes a browser-independent handler for verification, password reset, email recovery, and email change links. To route new account emails through it, add `campusos.campusos-app.workers.dev` under **Firebase Console → Authentication → Settings → Authorized domains**, then open **Authentication → Templates → Email address verification**, edit the custom action URL, and set it to `https://campusos.campusos-app.workers.dev/`. Firebase applies this custom action URL across its email templates, so the app handles the supported `mode` values and removes one-time codes from the address bar. Keep the Firebase web `authDomain` as `campusos-f5cfc.firebaseapp.com`.

For a local development build, add `localhost` to Authorized domains and set the template action URL to the local Vite origin (for example `http://localhost:5173/`) only while testing; restore the deployed URL afterward. Firebase's [custom email action handler guide](https://firebase.google.com/docs/auth/custom-email-handler) explains the template configuration and action parameters.

## Database and access

The app requires a signed-in, email-verified Firebase user before showing the CampusOS workspace. Student profile sections, courses, assignments, timetable, exams, study notes, and grades are saved to IndexedDB on this device first, then queued for Firestore sync. Each student’s records are partitioned by account UID. Offline edits remain on the device until connectivity returns; they are not visible on another device until sync completes. Firestore remains the shared source of truth. Firestore Security Rules are in [`firestore.rules`](firestore.rules); schema, deployment, access-control, and operational guidance is in [`docs/FIRESTORE.md`](docs/FIRESTORE.md).

The app is deployed at [campusos.campusos-app.workers.dev](https://campusos.campusos-app.workers.dev) with Cloudflare static-asset delivery, Smart Placement, and a same-origin Firestore Worker proxy. See [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) for deployment, security, caching, and rollback details.

## Device support

CampusOS is a responsive web app and installable PWA for current browsers on iOS, iPadOS, Android, macOS, Windows, and Linux. Layouts account for safe areas, touch targets, small viewports, and reduced-motion preferences. The web build is not a native watchOS app; watchOS web views are not supported by Apple, so dedicated Apple Watch support would require a separate native watchOS companion.

The rules expect trusted role claims for administrators and lecturers. Do not assign these claims from the client. Configure them only from a trusted Admin SDK environment, and add lecturer UIDs to a student record’s `authorizedStaffUids` only after verifying authorization. The Firestore region is permanent for this database.

The project is on Firebase Spark at setup time. Automated backups, point-in-time recovery, and scheduled exports may require billing/Blaze; review the current Firebase pricing and enable billing before relying on backups for official records.

## Development

Run `npm install`, then `npm run dev`. Run `npm run build` to create the production bundle.
