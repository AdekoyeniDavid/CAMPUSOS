const FIRESTORE_HOST = "firestore.googleapis.com";
const FIRESTORE_RPC_PREFIX = "/google.firestore.v1.Firestore/";
const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_REMINDER_BODY_BYTES = 16 * 1024;
const MAX_REMINDERS_PER_HOUR = 5;
const FIREBASE_KEYS_TIMEOUT_MS = 5000;
const EMAIL_SEND_TIMEOUT_MS = 8000;
const PUSH_TIMEOUT_MS = 8000;
const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
const MAX_TIMETABLE_REMINDERS_PER_USER = 200;
let firebaseKeysCache;
let firebaseKeysExpiresAt = 0;

function allowedOrigins(env) {
  return (env.CAMPUSOS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-goog-api-key, x-goog-api-client, x-user-agent, x-firebase-gmpid",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
}

function jsonError(message, status, origin) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
  if (origin) {
    for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  }
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function apiJson(data, status = 200, origin) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
  });
  if (origin) {
    for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

async function getFirebaseKeys() {
  if (firebaseKeysCache && Date.now() < firebaseKeysExpiresAt) return firebaseKeysCache;
  const response = await fetch(FIREBASE_JWKS_URL, {
    cf: { cacheTtl: 3600, cacheEverything: true },
    signal: AbortSignal.timeout(FIREBASE_KEYS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Firebase verification keys are unavailable.");
  const data = await response.json();
  firebaseKeysCache = new Map((data.keys ?? []).map((key) => [key.kid, key]));
  firebaseKeysExpiresAt = Date.now() + 60 * 60 * 1000;
  return firebaseKeysCache;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifiedFirebaseUser(request, projectId) {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3 || !projectId) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const keyData = (await getFirebaseKeys()).get(header.kid);
  if (!keyData) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const validSignature = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const now = Math.floor(Date.now() / 1000);
    if (!validSignature || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128 || !Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60 || claims.email_verified !== true || typeof claims.email !== "string" || !claims.email.trim() || claims.email.length > 320) return null;
    return { email: claims.email, uid: claims.sub };
  } catch {
    return null;
  }
}

async function readJsonWithinLimit(request) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return { ok: false, error: "Use a JSON reminder request.", status: 415 };
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMINDER_BODY_BYTES) return { ok: false, error: "The reminder request is too large.", status: 413 };
  if (!request.body) return { ok: false, error: "Invalid reminder request.", status: 400 };

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REMINDER_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: "The reminder request is too large.", status: 413 };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, error: "Invalid reminder request.", status: 400 };
  } finally {
    reader.releaseLock();
  }
}

async function consumeReminderQuota(env, uid) {
  const currentWindow = Math.floor(Date.now() / 3_600_000);
  const result = await env.CAMPUSOS_DB.prepare(`
    INSERT INTO email_reminder_rate_limits (uid, window_key, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(uid) DO UPDATE SET
      window_key = excluded.window_key,
      request_count = CASE
        WHEN email_reminder_rate_limits.window_key = excluded.window_key
        THEN email_reminder_rate_limits.request_count + 1
        ELSE 1
      END
    WHERE email_reminder_rate_limits.window_key <> excluded.window_key
       OR email_reminder_rate_limits.request_count < ?
    RETURNING request_count
  `).bind(uid, currentWindow, MAX_REMINDERS_PER_HOUR).all();
  return result.success && Array.isArray(result.results) && result.results.length > 0;
}

async function sendEmailReminders(request, env) {
  const origin = request.headers.get("Origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin && origin !== requestOrigin && !allowedOrigins(env).includes(origin)) {
    return apiJson({ error: "Origin is not allowed." }, 403);
  }

  let user;
  try {
    user = await verifiedFirebaseUser(request, env.FIREBASE_PROJECT_ID);
  } catch {
    return apiJson({ error: "Authentication could not be checked right now. Try again shortly." }, 503, origin === requestOrigin ? origin : undefined);
  }
  if (!user) return apiJson({ error: "Sign in with a verified email account to send reminders." }, 401, origin === requestOrigin ? origin : undefined);
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return apiJson({ error: "Email reminders are not configured yet." }, 503, origin === requestOrigin ? origin : undefined);

  const parsed = await readJsonWithinLimit(request);
  if (!parsed.ok) return apiJson({ error: parsed.error }, parsed.status, origin === requestOrigin ? origin : undefined);
  const body = parsed.body;
  const reminders = body?.reminders;
  if (!Array.isArray(reminders) || reminders.length < 1 || reminders.length > 20 || reminders.some((item) => !item || typeof item.title !== "string" || !item.title.trim() || typeof item.course !== "string" || !item.course.trim() || typeof item.due !== "string" || !item.due.trim() || item.title.length > 200 || item.course.length > 100 || item.due.length > 80)) {
    return apiJson({ error: "Provide 1 to 20 valid assignment reminders." }, 400, origin === requestOrigin ? origin : undefined);
  }

  try {
    const withinQuota = await consumeReminderQuota(env, user.uid);
    if (!withinQuota) return apiJson({ error: "You have reached the reminder email limit. Try again later." }, 429, origin === requestOrigin ? origin : undefined);
  } catch {
    return apiJson({ error: "Reminder service is temporarily unavailable. Try again shortly." }, 503, origin === requestOrigin ? origin : undefined);
  }
  const text = ["Your pending CampusOS assignments:", "", ...reminders.map((item, index) => `${index + 1}. ${item.title} — ${item.course}, due ${item.due}`), "", "Open CampusOS to review your assignments."].join("\n");
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [user.email], subject: "Your CampusOS assignment reminders", text }),
      signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
    });
    if (!response.ok) return apiJson({ error: "The email service could not send reminders. Try again later." }, 502, origin === requestOrigin ? origin : undefined);
    return apiJson({ ok: true, count: reminders.length }, 200, origin === requestOrigin ? origin : undefined);
  } catch {
    return apiJson({ error: "The email service could not be reached. Try again later." }, 502, origin === requestOrigin ? origin : undefined);
  }
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hkdf(secret, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function concatBytes(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

async function encryptPushPayload(subscription, payload) {
  const receiverPublic = decodeBase64Url(subscription.keys.p256dh);
  const authSecret = decodeBase64Url(subscription.keys.auth);
  if (receiverPublic.length !== 65 || authSecret.length !== 16) throw new Error("Invalid subscription encryption keys.");
  const receiverKey = await crypto.subtle.importKey("raw", receiverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const senderPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", senderPair.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, senderPair.privateKey, 256));
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, concatBytes(new TextEncoder().encode("WebPush: info\0"), receiverPublic, senderPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(inputKeyMaterial, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(inputKeyMaterial, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const plaintext = concatBytes(new TextEncoder().encode(JSON.stringify(payload)), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));
  const recordSize = new Uint8Array([0, 0, 16, 0]);
  return concatBytes(salt, recordSize, new Uint8Array([senderPublic.length]), senderPublic, ciphertext);
}

async function createVapidAuthorization(endpoint, env) {
  if (!env.PUSH_VAPID_PRIVATE_KEY || !env.PUSH_VAPID_PUBLIC_KEY) throw new Error("Push reminders are not configured.");
  const privateKey = await crypto.subtle.importKey("pkcs8", decodeBase64Url(env.PUSH_VAPID_PRIVATE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: env.PUSH_VAPID_SUBJECT || "mailto:support@campusos.app" })));
  const unsigned = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(unsigned)));
  return `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${env.PUSH_VAPID_PUBLIC_KEY}`;
}

function zonedParts(date, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function localDateTimeToUtc(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = desired - actualUtc;
    if (!delta) break;
    guess += delta;
  }
  return guess;
}

function nextTimetableNotification(row, now = Date.now()) {
  const zone = row.time_zone;
  const fireOffset = Number(row.lead_minutes) * 60_000;
  if (row.source_type === "exam") return localDateTimeToUtc(row.local_date, row.local_time, zone) - fireOffset;
  const current = zonedParts(new Date(now), zone);
  const currentDate = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const targetWeekday = Number(row.day_of_week);
  const currentWeekday = currentDate.getUTCDay();
  let daysAhead = (targetWeekday - currentWeekday + 7) % 7;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const date = new Date(currentDate.getTime() + daysAhead * 86_400_000);
    const dateText = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const fireAt = localDateTimeToUtc(dateText, row.local_time, zone) - fireOffset;
    if (fireAt > now) return fireAt;
    daysAhead += 7;
  }
  return null;
}

async function listTimetableReminders(env, user) {
  const result = await env.CAMPUSOS_DB.prepare("SELECT source_type, source_id, lead_minutes FROM timetable_notification_reminders WHERE uid = ?").bind(user.uid).all();
  if (!result.success) return apiJson({ error: "Could not load timetable reminders." }, 503);
  return apiJson({ reminders: (result.results ?? []).map((row) => ({ sourceType: row.source_type, sourceId: row.source_id, leadMinutes: row.lead_minutes })) });
}

async function saveTimetableReminder(env, user, body) {
  if (body?.action === "removeCourse") {
    if (typeof body.courseCode !== "string" || !/^[\w -]{1,32}$/.test(body.courseCode)) return apiJson({ error: "Select a valid course." }, 400);
    await env.CAMPUSOS_DB.prepare("DELETE FROM timetable_notification_reminders WHERE uid = ? AND course_code = ?").bind(user.uid, body.courseCode.toUpperCase()).run();
    return apiJson({ ok: true, removed: true });
  }
  const sourceType = body?.action === "remove" ? body.sourceType : body?.sourceType;
  const sourceId = body?.sourceId;
  if (!["weekly", "exam"].includes(sourceType) || typeof sourceId !== "string" || !/^[\w-]{1,128}$/.test(sourceId)) return apiJson({ error: "Select a valid timetable entry." }, 400);
  if (body.action === "remove") {
    await env.CAMPUSOS_DB.prepare("DELETE FROM timetable_notification_reminders WHERE uid = ? AND source_type = ? AND source_id = ?").bind(user.uid, sourceType, sourceId).run();
    return apiJson({ ok: true, removed: true });
  }
  const leadMinutes = Number(body.leadMinutes);
  const timeZone = body.timeZone;
  const localTime = body.time;
  if (![5, 15, 30, 60].includes(leadMinutes) || typeof timeZone !== "string" || timeZone.length > 80 || typeof localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) return apiJson({ error: "Choose a valid reminder time and device time zone." }, 400);
  try { new Intl.DateTimeFormat("en", { timeZone }); } catch { return apiJson({ error: "The device time zone is invalid." }, 400); }
  const title = body.title;
  const courseCode = body.courseCode;
  const location = typeof body.location === "string" ? body.location.slice(0, 160) : "";
  if (typeof title !== "string" || !title.trim() || title.length > 160 || typeof courseCode !== "string" || !/^[\w -]{1,32}$/.test(courseCode)) return apiJson({ error: "The timetable reminder details are invalid." }, 400);
  const row = { source_type: sourceType, local_time: localTime, local_date: body.date, day_of_week: body.dayOfWeek, time_zone: timeZone, lead_minutes: leadMinutes };
  if (sourceType === "weekly" && (!Number.isInteger(body.dayOfWeek) || body.dayOfWeek < 0 || body.dayOfWeek > 6)) return apiJson({ error: "Choose a valid class day." }, 400);
  if (sourceType === "exam") {
    const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? new Date(`${body.date}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.date) return apiJson({ error: "Choose a valid exam date." }, 400);
  }
  const nextFireAt = nextTimetableNotification(row);
  if (!nextFireAt || (sourceType === "exam" && nextFireAt <= Date.now())) return apiJson({ error: "This exam reminder time has already passed." }, 400);
  const existing = await env.CAMPUSOS_DB.prepare("SELECT 1 FROM timetable_notification_reminders WHERE uid = ? AND source_type = ? AND source_id = ? LIMIT 1").bind(user.uid, sourceType, sourceId).first();
  if (!existing) {
    const count = await env.CAMPUSOS_DB.prepare("SELECT COUNT(*) AS count FROM timetable_notification_reminders WHERE uid = ?").bind(user.uid).first();
    if (Number(count?.count ?? 0) >= MAX_TIMETABLE_REMINDERS_PER_USER) return apiJson({ error: "This account has reached its active timetable reminder limit." }, 429);
  }
  const id = `${user.uid}:${sourceType}:${sourceId}`;
  const result = await env.CAMPUSOS_DB.prepare(`INSERT INTO timetable_notification_reminders
    (id, uid, source_type, source_id, title, course_code, local_date, day_of_week, local_time, time_zone, location, lead_minutes, next_fire_at, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch())
    ON CONFLICT(uid, source_type, source_id) DO UPDATE SET title = excluded.title, course_code = excluded.course_code,
      local_date = excluded.local_date, day_of_week = excluded.day_of_week, local_time = excluded.local_time, time_zone = excluded.time_zone,
      location = excluded.location, lead_minutes = excluded.lead_minutes, next_fire_at = excluded.next_fire_at, locked_until = 0, updated_at = unixepoch()
    RETURNING source_id`).bind(id, user.uid, sourceType, sourceId, title.trim(), courseCode, sourceType === "exam" ? body.date : null, sourceType === "weekly" ? body.dayOfWeek : null, localTime, timeZone, location, leadMinutes, nextFireAt).all();
  if (!result.success || !result.results?.length) return apiJson({ error: "Could not save this timetable reminder." }, 503);
  return apiJson({ ok: true, sourceType, sourceId, leadMinutes, nextFireAt });
}

async function listAssignmentReminders(env, user) {
  const result = await env.CAMPUSOS_DB.prepare("SELECT assignment_id, due_date, due_time, lead_minutes FROM assignment_notification_reminders WHERE uid = ?").bind(user.uid).all();
  if (!result.success) return apiJson({ error: "Could not load assignment reminders." }, 503);
  return apiJson({ reminders: (result.results ?? []).map((row) => ({ assignmentId: row.assignment_id, dueDate: row.due_date, dueTime: row.due_time, leadMinutes: row.lead_minutes })) });
}

async function saveAssignmentReminder(env, user, body) {
  const assignmentId = body?.assignmentId;
  if (typeof assignmentId !== "string" || !/^[\w-]{1,128}$/.test(assignmentId)) return apiJson({ error: "Select a valid assignment." }, 400);
  if (body.action === "remove") {
    const result = await env.CAMPUSOS_DB.prepare("DELETE FROM assignment_notification_reminders WHERE uid = ? AND assignment_id = ?").bind(user.uid, assignmentId).run();
    if (!result.success) return apiJson({ error: "Could not remove this assignment reminder." }, 503);
    return apiJson({ ok: true, removed: true });
  }
  const title = body.title;
  const courseCode = body.courseCode;
  const dueDate = body.dueDate;
  const dueTime = body.dueTime;
  const timeZone = body.timeZone;
  const leadMinutes = Number(body.leadMinutes);
  if (typeof title !== "string" || !title.trim() || title.length > 200 || typeof courseCode !== "string" || !courseCode.trim() || courseCode.length > 100) return apiJson({ error: "Assignment details are invalid." }, 400);
  const date = typeof dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? new Date([dueDate, "T00:00:00Z"].join("")) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate) return apiJson({ error: "Choose a valid assignment due date." }, 400);
  if (typeof dueTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime) || typeof timeZone !== "string" || timeZone.length > 80 || ![5, 15, 30, 60, 1440].includes(leadMinutes)) return apiJson({ error: "Choose a valid due time, reminder lead time, and device time zone." }, 400);
  try { new Intl.DateTimeFormat("en", { timeZone }); } catch { return apiJson({ error: "The device time zone is invalid." }, 400); }
  const dueAt = localDateTimeToUtc(dueDate, dueTime, timeZone);
  const nextFireAt = dueAt - leadMinutes * 60_000;
  if (nextFireAt <= Date.now()) return apiJson({ error: "This assignment reminder time has already passed." }, 400);
  const existing = await env.CAMPUSOS_DB.prepare("SELECT 1 FROM assignment_notification_reminders WHERE uid = ? AND assignment_id = ? LIMIT 1").bind(user.uid, assignmentId).first();
  if (!existing) {
    const count = await env.CAMPUSOS_DB.prepare("SELECT COUNT(*) AS count FROM assignment_notification_reminders WHERE uid = ?").bind(user.uid).first();
    if (Number(count?.count ?? 0) >= MAX_TIMETABLE_REMINDERS_PER_USER) return apiJson({ error: "This account has reached its active assignment reminder limit." }, 429);
  }
  const id = `${user.uid}:assignment:${assignmentId}`;
  const saved = await env.CAMPUSOS_DB.prepare(`INSERT INTO assignment_notification_reminders
    (id, uid, assignment_id, title, course_code, due_date, due_time, time_zone, lead_minutes, next_fire_at, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch())
    ON CONFLICT(uid, assignment_id) DO UPDATE SET title = excluded.title, course_code = excluded.course_code,
      due_date = excluded.due_date, due_time = excluded.due_time, time_zone = excluded.time_zone,
      lead_minutes = excluded.lead_minutes, next_fire_at = excluded.next_fire_at, locked_until = 0, updated_at = unixepoch()
    RETURNING assignment_id`).bind(id, user.uid, assignmentId, title.trim(), courseCode.trim().slice(0, 100), dueDate, dueTime, timeZone, leadMinutes, nextFireAt).all();
  if (!saved.success || !saved.results?.length) return apiJson({ error: "Could not save this assignment reminder." }, 503);
  return apiJson({ ok: true, assignmentId, dueDate, dueTime, leadMinutes, nextFireAt });
}

async function deliverScheduledTimetableReminder(env, row) {
  const result = await env.CAMPUSOS_DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE uid = ?").bind(row.uid).all();
  const subscriptions = result.results ?? [];
  let delivered = 0;
  const title = row.source_type === "exam" ? `Exam reminder: ${row.title}` : `Class reminder: ${row.title}`;
  const place = row.location ? ` · ${row.location}` : "";
  const body = row.source_type === "exam"
    ? `${row.course_code} · Exam starts in ${row.lead_minutes} minutes${place}.`
    : `${row.course_code} · Class starts in ${row.lead_minutes} minutes.`;
  const payload = { title, body, tag: `timetable-${row.source_type}-${row.source_id}`, url: "/" };
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      const sub = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } };
      const encrypted = await encryptPushPayload(sub, payload);
      const response = await fetch(subscription.endpoint, {
        method: "POST",
        headers: { Authorization: await createVapidAuthorization(subscription.endpoint, env), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" },
        body: encrypted,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 410) {
        await env.CAMPUSOS_DB.prepare("DELETE FROM push_subscriptions WHERE uid = ? AND endpoint = ?").bind(row.uid, subscription.endpoint).run();
      } else if (response.ok) delivered += 1;
    } catch { /* Keep the reminder due and retry on a later cron tick. */ }
  }));
  return { attempted: subscriptions.length, delivered };
}

async function processDueTimetableReminders(env) {
  const now = Date.now();
  const due = await env.CAMPUSOS_DB.prepare("SELECT * FROM timetable_notification_reminders WHERE next_fire_at <= ? AND locked_until <= ? ORDER BY next_fire_at LIMIT 100").bind(now, now).all();
  const rows = due.results ?? [];
  for (let offset = 0; offset < rows.length; offset += 4) await Promise.all(rows.slice(offset, offset + 4).map(async (row) => {
    const claim = await env.CAMPUSOS_DB.prepare("UPDATE timetable_notification_reminders SET locked_until = ? WHERE id = ? AND next_fire_at = ? AND locked_until <= ? RETURNING id").bind(now + 90_000, row.id, row.next_fire_at, now).all();
    if (!claim.success || !claim.results?.length) return;
    if (now - Number(row.next_fire_at) > 10 * 60_000) {
      if (row.source_type === "exam") await env.CAMPUSOS_DB.prepare("DELETE FROM timetable_notification_reminders WHERE id = ?").bind(row.id).run();
      else {
        const nextFireAt = nextTimetableNotification(row, now);
        await env.CAMPUSOS_DB.prepare("UPDATE timetable_notification_reminders SET next_fire_at = ?, locked_until = 0, updated_at = unixepoch() WHERE id = ?").bind(nextFireAt, row.id).run();
      }
      return;
    }
    const delivery = await deliverScheduledTimetableReminder(env, row);
    if (delivery.delivered > 0) {
      if (row.source_type === "exam") await env.CAMPUSOS_DB.prepare("DELETE FROM timetable_notification_reminders WHERE id = ?").bind(row.id).run();
      else {
        const nextFireAt = nextTimetableNotification(row, now);
        await env.CAMPUSOS_DB.prepare("UPDATE timetable_notification_reminders SET next_fire_at = ?, locked_until = 0, updated_at = unixepoch() WHERE id = ?").bind(nextFireAt, row.id).run();
      }
    } else await env.CAMPUSOS_DB.prepare("UPDATE timetable_notification_reminders SET locked_until = 0 WHERE id = ?").bind(row.id).run();
  }));
}

async function processDueAssignmentReminders(env) {
  const now = Date.now();
  const due = await env.CAMPUSOS_DB.prepare("SELECT * FROM assignment_notification_reminders WHERE next_fire_at <= ? AND locked_until <= ? ORDER BY next_fire_at LIMIT 100").bind(now, now).all();
  const rows = due.results ?? [];
  for (let offset = 0; offset < rows.length; offset += 4) await Promise.all(rows.slice(offset, offset + 4).map(async (row) => {
    const claim = await env.CAMPUSOS_DB.prepare("UPDATE assignment_notification_reminders SET locked_until = ? WHERE id = ? AND next_fire_at = ? AND locked_until <= ? RETURNING id").bind(now + 90_000, row.id, row.next_fire_at, now).all();
    if (!claim.success || !claim.results?.length) return;
    if (now - Number(row.next_fire_at) > 10 * 60_000) {
      await env.CAMPUSOS_DB.prepare("DELETE FROM assignment_notification_reminders WHERE id = ?").bind(row.id).run();
      return;
    }
    const subscriptions = await env.CAMPUSOS_DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE uid = ?").bind(row.uid).all();
    let delivered = 0;
    await Promise.all((subscriptions.results ?? []).map(async (subscription) => {
      try {
        const pushSubscription = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } };
        const payload = { title: `Assignment reminder: ${row.title}`, body: `${row.course_code} · Due ${row.due_date} at ${row.due_time}`, tag: `assignment-${row.assignment_id}`, url: "/" };
        const encrypted = await encryptPushPayload(pushSubscription, payload);
        const response = await fetch(subscription.endpoint, { method: "POST", headers: { Authorization: await createVapidAuthorization(subscription.endpoint, env), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" }, body: encrypted, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
        if (response.status === 404 || response.status === 410) {
          await env.CAMPUSOS_DB.prepare("DELETE FROM push_subscriptions WHERE uid = ? AND endpoint = ?").bind(row.uid, subscription.endpoint).run();
        } else if (response.ok) delivered += 1;
      } catch { /* Keep due reminders queued for the next cron tick. */ }
    }));
    if (delivered) await env.CAMPUSOS_DB.prepare("DELETE FROM assignment_notification_reminders WHERE id = ?").bind(row.id).run();
    else await env.CAMPUSOS_DB.prepare("UPDATE assignment_notification_reminders SET locked_until = 0 WHERE id = ?").bind(row.id).run();
  }));
}

function validPushEndpoint(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host.endsWith(".push.apple.com"));
  } catch { return false; }
}

async function pushRequest(request, env, action) {
  const origin = request.headers.get("Origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin && origin !== requestOrigin && !allowedOrigins(env).includes(origin)) return apiJson({ error: "Origin is not allowed." }, 403);
  if (action === "config") return apiJson({ publicKey: env.PUSH_VAPID_PUBLIC_KEY || null, configured: Boolean(env.PUSH_VAPID_PUBLIC_KEY && env.PUSH_VAPID_PRIVATE_KEY) });
  let user;
  try { user = await verifiedFirebaseUser(request, env.FIREBASE_PROJECT_ID); }
  catch { return apiJson({ error: "Authentication could not be checked right now. Try again shortly." }, 503); }
  if (!user) return apiJson({ error: "Sign in with a verified email account to manage device reminders." }, 401);

  if (action === "timetable" && request.method === "GET") return listTimetableReminders(env, user);
  if (action === "assignment" && request.method === "GET") return listAssignmentReminders(env, user);

  const parsed = await readJsonWithinLimit(request);
  if (!parsed.ok) return apiJson({ error: parsed.error }, parsed.status);
  if (action === "timetable") return saveTimetableReminder(env, user, parsed.body);
  if (action === "assignment") return saveAssignmentReminder(env, user, parsed.body);
  const subscription = parsed.body?.subscription;
  if (action === "subscribe" || action === "unsubscribe") {
    if (!subscription || typeof subscription.endpoint !== "string" || subscription.endpoint.length > 2048 || !validPushEndpoint(subscription.endpoint)) return apiJson({ error: "The device push subscription is invalid." }, 400);
    if (action === "unsubscribe") {
      await env.CAMPUSOS_DB.prepare("DELETE FROM push_subscriptions WHERE uid = ? AND endpoint = ?").bind(user.uid, subscription.endpoint).run();
      return apiJson({ ok: true });
    }
    if (typeof subscription.keys?.p256dh !== "string" || typeof subscription.keys?.auth !== "string" || !/^[A-Za-z0-9_-]+$/.test(subscription.keys.p256dh) || !/^[A-Za-z0-9_-]+$/.test(subscription.keys.auth)) return apiJson({ error: "The device push subscription keys are invalid." }, 400);
    let publicKeyBytes;
    let authKeyBytes;
    try { publicKeyBytes = decodeBase64Url(subscription.keys.p256dh); authKeyBytes = decodeBase64Url(subscription.keys.auth); }
    catch { return apiJson({ error: "The device push subscription keys are invalid." }, 400); }
    if (publicKeyBytes.length !== 65 || authKeyBytes.length !== 16) return apiJson({ error: "The device push subscription keys are invalid." }, 400);
    const existing = await env.CAMPUSOS_DB.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND uid = ? LIMIT 1").bind(subscription.endpoint, user.uid).first();
    if (!existing) {
      const count = await env.CAMPUSOS_DB.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE uid = ?").bind(user.uid).first();
      if (Number(count?.count ?? 0) >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) return apiJson({ error: "This account already has the maximum number of notification devices." }, 429);
    }
    const result = await env.CAMPUSOS_DB.prepare(`INSERT INTO push_subscriptions (endpoint, uid, p256dh, auth, created_at, updated_at)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = unixepoch()
      WHERE push_subscriptions.uid = excluded.uid RETURNING endpoint`).bind(subscription.endpoint, user.uid, subscription.keys.p256dh, subscription.keys.auth).all();
    if (!result.success || !result.results?.length) return apiJson({ error: "This device subscription is already linked to another account." }, 409);
    return apiJson({ ok: true });
  }

  if (action !== "send") return apiJson({ error: "Unsupported push reminder action." }, 400);
  if (!env.PUSH_VAPID_PUBLIC_KEY || !env.PUSH_VAPID_PRIVATE_KEY) return apiJson({ error: "Background push reminders are not configured yet." }, 503);
  const reminders = parsed.body?.reminders;
  if (!Array.isArray(reminders) || reminders.length < 1 || reminders.length > 20 || reminders.some((item) => !item || typeof item.id !== "string" || item.id.length > 128 || typeof item.title !== "string" || !item.title.trim() || item.title.length > 200 || typeof item.course !== "string" || !item.course.trim() || item.course.length > 100 || typeof item.due !== "string" || item.due.length > 80)) return apiJson({ error: "Provide 1 to 20 valid assignment reminders." }, 400);
  const quota = await env.CAMPUSOS_DB.prepare(`INSERT INTO push_reminder_rate_limits (uid, window_key, request_count) VALUES (?, ?, 1)
    ON CONFLICT(uid) DO UPDATE SET window_key = excluded.window_key, request_count = CASE WHEN push_reminder_rate_limits.window_key = excluded.window_key THEN push_reminder_rate_limits.request_count + 1 ELSE 1 END
    WHERE push_reminder_rate_limits.window_key <> excluded.window_key OR push_reminder_rate_limits.request_count < 30 RETURNING request_count`).bind(user.uid, Math.floor(Date.now() / 3_600_000)).all();
  if (!quota.success || !quota.results?.length) return apiJson({ error: "You have reached the device reminder limit. Try again later." }, 429);
  const rows = await env.CAMPUSOS_DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE uid = ?").bind(user.uid).all();
  if (!rows.success || !rows.results?.length) return apiJson({ error: "No device is subscribed yet. Enable notifications on this device first." }, 404);
  const deliveries = await Promise.all(rows.results.map(async (row) => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    let sent = 0;
    for (const item of reminders) {
      try {
        const payload = { title: `Assignment reminder: ${item.title}`, body: `${item.course} · Due ${item.due}`, tag: `assignment-${item.id}`, url: "/" };
        const body = await encryptPushPayload(sub, payload);
        const response = await fetch(row.endpoint, { method: "POST", headers: { Authorization: await createVapidAuthorization(row.endpoint, env), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "86400", "Urgency": "normal" }, body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
        if (response.status === 404 || response.status === 410) {
          await env.CAMPUSOS_DB.prepare("DELETE FROM push_subscriptions WHERE uid = ? AND endpoint = ?").bind(user.uid, row.endpoint).run();
          break;
        }
        if (!response.ok) break;
        sent += 1;
      } catch { break; }
    }
    return sent;
  }));
  const sent = deliveries.reduce((total, count) => total + count, 0);
  if (!sent) return apiJson({ error: "The push service could not deliver the reminders. The device subscription is kept for retry." }, 502);
  return apiJson({ ok: true, count: sent });
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname === "/api/reminders/email") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store", ...securityHeaders() } });
      return sendEmailReminders(request, env);
    }
    if (incomingUrl.pathname.startsWith("/api/reminders/push/")) {
      const action = incomingUrl.pathname.slice("/api/reminders/push/".length);
      if (!["config", "subscribe", "unsubscribe", "send", "timetable", "assignment"].includes(action)) return apiJson({ error: "Not found." }, 404);
      const methods = action === "config" ? ["GET"] : ["timetable", "assignment"].includes(action) ? ["GET", "POST"] : ["POST"];
      if (!methods.includes(request.method)) return new Response(null, { status: 405, headers: { Allow: methods.join(", "), "Cache-Control": "no-store", ...securityHeaders() } });
      return pushRequest(request, env, action);
    }
    if (incomingUrl.pathname === "/api/d1/health") {
      if (request.method !== "GET") {
        return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store", ...securityHeaders() } });
      }
      try {
        await env.CAMPUSOS_DB.prepare("SELECT 1").first();
        return apiJson({ ok: true, database: "available" });
      } catch {
        return apiJson({ ok: false, database: "unavailable" }, 503);
      }
    }
    if (!incomingUrl.pathname.startsWith(FIRESTORE_RPC_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    const origin = request.headers.get("Origin");
    const sameOrigin = origin === incomingUrl.origin;
    const originAllowed = !origin || sameOrigin || allowedOrigins(env).includes(origin);
    if (!originAllowed) return jsonError("Origin is not allowed.", 403);

    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 204 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return jsonError("Unsupported Firestore transport method.", 405, origin && !sameOrigin ? origin : null);
    }

    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = "https:";
    upstreamUrl.hostname = FIRESTORE_HOST;
    upstreamUrl.port = "";
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("cookie");

    try {
      const upstreamRequest = new Request(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : request.body,
        redirect: "manual",
      });
      const upstreamResponse = await fetch(upstreamRequest);
      const responseHeaders = new Headers(upstreamResponse.headers);
      responseHeaders.set("Cache-Control", "private, no-store, max-age=0");
      for (const [name, value] of Object.entries(securityHeaders())) responseHeaders.set(name, value);
      if (origin && !sameOrigin) {
        for (const [name, value] of corsHeaders(origin)) responseHeaders.set(name, value);
      }
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch {
      return jsonError("Firestore could not be reached. Please retry.", 502, origin && !sameOrigin ? origin : null);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      processDueTimetableReminders(env).catch((error) => console.error(JSON.stringify({ event: "timetable-reminder-cron-failed", error: error instanceof Error ? error.message : String(error) }))),
      processDueAssignmentReminders(env).catch((error) => console.error(JSON.stringify({ event: "assignment-reminder-cron-failed", error: error instanceof Error ? error.message : String(error) }))),
    ]));
  },
};
