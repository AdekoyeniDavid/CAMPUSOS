# CampusOS

CampusOS is a student dashboard built with React, TypeScript, and Vite.

## Firebase setup

This checkout is configured for Firebase project `campusos-f5cfc`; its web app is registered, Firebase Authentication **Email/Password** is enabled, and Firestore is provisioned in `africa-south1` (Johannesburg). The local `.env` contains the Firebase web configuration and is ignored by Git. `localhost` is already an authorized domain for development.

For another checkout, copy `.env.example` to `.env`, fill in the Firebase Web app values, enable Email/Password in **Authentication → Sign-in method**, and restart the development server. Firebase web configuration is intended to be used by client apps; never put service account credentials in `.env`.

Students can register with their name, email, and password, verify their email, sign in, request a password reset, and sign out. Sessions use browser-session persistence. Firebase verification and password-reset messages use the templates configured in the Firebase console.

## Database and access

The app requires a signed-in, email-verified Firebase user before showing the CampusOS workspace. Student profile sections and My Courses, Assignment, weekly Timetable, and Exam timetable records sync to Firestore. Each student’s records are stored under that account’s UID. Firestore Security Rules are in [`firestore.rules`](firestore.rules); schema, deployment, access-control, and operational guidance is in [`docs/FIRESTORE.md`](docs/FIRESTORE.md).

The production app is deployed at [campusos.ajiboladavid697.workers.dev](https://campusos.ajiboladavid697.workers.dev) with Cloudflare static-asset delivery, Smart Placement, and a same-origin Firestore Worker proxy. See [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) for deployment, security, caching, and rollback details.

The rules expect trusted role claims for administrators and lecturers. Do not assign these claims from the client. Configure them only from a trusted Admin SDK environment, and add lecturer UIDs to a student record’s `authorizedStaffUids` only after verifying authorization. The Firestore region is permanent for this database.

The project is on Firebase Spark at setup time. Automated backups, point-in-time recovery, and scheduled exports may require billing/Blaze; review the current Firebase pricing and enable billing before relying on backups for official records.

## Development

Run `npm install`, then `npm run dev`. Run `npm run build` to create the production bundle.
