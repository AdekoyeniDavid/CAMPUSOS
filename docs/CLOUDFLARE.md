# CampusOS Cloudflare performance setup

## What is configured

- Live deployment: [https://campusos.campusos-app.workers.dev](https://campusos.campusos-app.workers.dev). The production build points Firebase Firestore to this same-origin Worker.
- `wrangler.jsonc` deploys the Vite build from `dist/` as Cloudflare Worker static assets. Cloudflare serves and caches the hashed JS, CSS, and image assets from its global edge network. The React single-page app fallback is enabled.
- `workers/index.js` proxies only Firestore WebChannel RPC requests to `firestore.googleapis.com`. All other requests go to the static asset binding. Firebase Authentication remains with Firebase Auth.
- `VITE_FIRESTORE_WORKER_HOST` is set to `campusos.campusos-app.workers.dev` for the deployed build. For another environment, set it to the Worker hostname without a scheme; leave it blank to connect directly to Firebase.
- Worker Smart Placement is enabled to let Cloudflare optimize the proxy's location relative to the Firestore backend. Placement needs real traffic to evaluate and is not an unconditional latency guarantee.
- Cloudflare D1 database `campusos-data` is provisioned and bound to the Worker as `CAMPUSOS_DB`. `GET /api/d1/health` checks that the binding is reachable without returning database contents.
- `POST /api/reminders/email` verifies a Firebase ID token and can send pending assignments using Resend. The recipient comes from the verified token, never from the request body.

## Security and caching

The Worker forwards the Firebase user's ID token to Firestore. Firestore Security Rules remain the authorization boundary; the Worker does not use a service account or bypass those rules. The request path is limited to Firestore RPCs, and the Worker strips cookies and browser origin headers before forwarding.

Exam, profile, course, assignment, and timetable data is personal. Proxy responses are explicitly `Cache-Control: private, no-store`; do not add a shared edge cache for authenticated Firestore reads or writes. Cloudflare Workers Cache is intended for repeatable `GET`/`HEAD` responses, not changing per-user data. The static assets are globally cached as part of the Workers static asset service. Firebase Firestore remains the authoritative student-record database; the D1 binding is available for Worker-managed SQL data and does not duplicate student records.

## Deploy

1. Install dependencies with `npm install` (Wrangler is included in `devDependencies`).
2. Sign in to the intended Cloudflare account with `npx wrangler login`.
3. Set `VITE_FIRESTORE_WORKER_HOST` in the production build environment to the deployed Worker hostname, then run `npm run cloudflare:deploy`. Do not commit `.env` or `.dev.vars` files.
4. If the app is served from a different origin than the Worker, set the Worker environment variable `CAMPUSOS_ALLOWED_ORIGINS` to the exact comma-separated app origins. Avoid wildcard origins. Local Worker development can use an ignored `.dev.vars` file.
5. Verify sign-in, exam create/edit/delete, course/assignment/timetable writes, offline/error states, and check that Firestore proxy responses have `Cache-Control: private, no-store`. Compare client request timing before and after enabling the proxy. Roll back by clearing `VITE_FIRESTORE_WORKER_HOST` if the extra hop increases latency.

## Assignment reminders by email

Email reminders require a Resend account and a sender address on a domain verified with Resend. Configure the Worker without putting provider credentials in the web app:

1. Add the Resend API key as a Worker secret: `npx wrangler secret put RESEND_API_KEY`.
2. Set `RESEND_FROM_EMAIL` as a Worker variable to the verified sender, for example `CampusOS <reminders@example.edu>`.
3. Deploy the Worker and use **Email me** in the reminders panel. The app sends at most 20 currently pending assignments per request to the signed-in, verified Firebase email address.

The Worker verifies Firebase token signatures and expiry against Google's published keys and checks the configured project audience. It does not log token or assignment contents. If email is not configured, the app reports that status and keeps local reminder actions available. Email requires connectivity. Desktop notifications are immediate and require permission on each browser/device; they do not schedule alerts while the app is closed.

The current deployment is in the signed-in Cloudflare account; its Worker hostname is documented above. Keep Firebase Security Rules deployed from `firestore.rules` in sync with the data shapes the app writes.
