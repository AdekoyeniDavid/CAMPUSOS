# CampusOS Firestore operations

## Provisioned service

- Firebase project: `campusos-f5cfc`
- Database: `(default)` / Cloud Firestore Standard edition
- Region: `africa-south1` (Johannesburg)
- Authentication: Firebase Email/Password; the app requires a verified email before entering the workspace.
- Rules and indexes: [`../firestore.rules`](../firestore.rules), [`../firestore.indexes.json`](../firestore.indexes.json)

Firestore locations cannot be changed after the database is created. Take region, data residency, latency, and recovery needs into account before creating a replacement database. See the [Firestore location guide](https://firebase.google.com/docs/firestore/locations).

## Data model

All app data is scoped below the authenticated student's UID:

```text
students/{uid}
  profile, institution, personal, contact, academic, enrolment, courses, progress
  authorizedStaffUids: []
  createdAt, updatedAt
students/{uid}/courses/{courseId}
  code, name, color, createdAt, updatedAt
students/{uid}/assignments/{assignmentId}
  title, question, course, due, completed, createdAt, updatedAt
students/{uid}/schedules/{scheduleId}
  courseCode, day, start, end, createdAt, updatedAt
students/{uid}/exams/{examId}
  title, courseCode, date, start, location, createdAt, updatedAt
```

The client creates the student root record at first verified sign-in and listens for live changes. Courses, assignments, weekly schedules, exams, and profile sections are written directly through the Firebase Web SDK. Course codes identify course documents; UUID document IDs identify assignment, schedule, and exam entries. Exam records include a title, course code, date, start time, and venue.

## Access control

The deployed rules require an authenticated, email-verified user. Students can read and update only their own profile sections and records. Student writes cannot change UID, email, creation time, or the authorized staff list. Input shape and selected field lengths are checked in the rules as well as in the app.

Role access is based on Firebase custom claims:

- `role: "admin"` can read all student records and manage records.
- `role: "lecturer"` can read a student's record only when their UID is present in that student's `authorizedStaffUids` list.
- Students cannot grant themselves staff access or role claims.

Custom claims and staff assignments must be managed by trusted server code using the Firebase Admin SDK. Never bundle a service account key or Admin SDK credentials into the browser app or commit them to this repository. No role-provisioning server is included in this client application, so lecturer/admin access is unavailable until a trusted provisioning process is implemented.

## Configure another checkout

1. Copy `.env.example` to `.env` and fill in the Firebase Web app configuration values from Project settings → Your apps.
2. Enable Email/Password in Firebase Authentication → Sign-in method and add the app's deployed host to Authentication → Settings → Authorized domains.
3. Install dependencies with `npm install`; run locally with `npm run dev`.
4. Install and authenticate the Firebase CLI using an authorized operator account. Verify `.firebaserc` targets the intended project before deployment.
5. Deploy rules and indexes with `firebase deploy --only firestore:rules,firestore:indexes`.
6. Check the Firestore Rules simulator with an email-verified student account. Verify owner access, cross-student denial, and unverified-user denial before releasing.

Do not point a production build at an unintended Firebase project. Review the selected project and rules diff before every deployment.

## Validation and errors

Rules are the database security boundary; client-side validation is for usability only. Keep both aligned when changing record fields. The UI listens for Firestore errors and reports a cloud sync message. When Firestore is unavailable or access is denied, fix connectivity/rules rather than falling back to browser storage as the permanent source of official student data.

## Backups, billing, and retention

At provisioning, Firebase Console showed automated backup and point-in-time recovery features as requiring the Blaze billing plan. No backup schedule or export has been configured. For official records, select an approved billing plan, set budget alerts, configure scheduled exports/backups to a protected Cloud Storage bucket, define retention and restore procedures, and periodically test recovery. Review the current [Firestore pricing and quotas](https://firebase.google.com/docs/firestore/quotas) and [backup documentation](https://firebase.google.com/docs/firestore/backups) before enabling these features; costs and availability can change.

## Privacy and release checklist

- Keep student records under `/students/{uid}` and use least-privilege rules.
- Do not log passwords, tokens, or sensitive profile data.
- Do not commit `.env`, private keys, exports, or production student data. `.env` is ignored; `.env.example` contains placeholders only.
- Use trusted server-side role assignment and verify staff authorization before populating `authorizedStaffUids`.
- Add rules tests for every new collection or field, then run the Firebase Emulator Suite before release.
- Review applicable institutional retention, privacy, and student-record requirements before using production records.
