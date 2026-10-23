# CampusOS Cloudflare performance setup

## What is configured

- `wrangler.jsonc` deploys the Vite build from `dist/` as Cloudflare Worker static assets. Cloudflare serves and caches the hashed JS, CSS, and image assets from its global edge network. The React single-page app fallback is enabled.
- `workers/index.js` proxies only Firestore WebChannel RPC requests to `firestore.googleapis.com`. All other requests go to the static asset binding. Firebase Authentication remains with Firebase Auth.
- Set `VITE_FIRESTORE_WORKER_HOST` to the Worker hostname (for example, `campusos.<account-subdomain>.workers.dev`, without a scheme) to opt the Firebase SDK into the proxy. Leave it blank to use Firebase directly until Cloudflare is configured.
- Worker Smart Placement is enabled to let Cloudflare optimize the proxy's location relative to the Firestore backend. Placement needs real traffic to evaluate and is not an unconditional latency guarantee.

## Security and caching

The Worker forwards the Firebase user's ID token to Firestore. Firestore Security Rules remain the authorization boundary; the Worker does not use a service account or bypass those rules. The request path is limited to Firestore RPCs, and the Worker strips cookies and browser origin headers before forwarding.

Exam, profile, course, assignment, and timetable data is personal. Proxy responses are explicitly `Cache-Control: private, no-store`; do not add a shared edge cache for authenticated Firestore reads or writes. Cloudflare Workers Cache is intended for repeatable `GET`/`HEAD` responses, not changing per-user data. The static assets are globally cached as part of the Workers static asset service. D1 is intentionally not added: Firestore remains the one authoritative student database, avoiding duplicate records and synchronization work.

## Deploy

1. Install Wrangler for this checkout: `npm install --save-dev wrangler`.
2. Sign in to the intended Cloudflare account: `npx wrangler login`.
3. Build and deploy: `npm run cloudflare:deploy`.
4. Set `VITE_FIRESTORE_WORKER_HOST` in the production build environment to the deployed Worker hostname, rebuild, and deploy again. Do not commit the populated `.env` file.
5. If the app is served from a different origin than the Worker, set the Worker environment variable `CAMPUSOS_ALLOWED_ORIGINS` to the exact comma-separated app origins. Avoid wildcard origins. Local Worker development can use an ignored `.dev.vars` file.
6. Verify sign-in, exam create/edit/delete, course/assignment/timetable writes, offline/error states, and check that Firestore proxy responses have `Cache-Control: private, no-store`. Compare client request timing before and after enabling the proxy. Roll back by clearing `VITE_FIRESTORE_WORKER_HOST` if the extra hop increases latency.

Cloudflare account access and the final hostname are not present in the repository. Deployment remains an operator step after authenticating to the intended Cloudflare account. Keep Firebase Security Rules deployed from `firestore.rules` in sync with the data shapes the app writes.
