const FIRESTORE_HOST = "firestore.googleapis.com";
const FIRESTORE_RPC_PREFIX = "/google.firestore.v1.Firestore/";
const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_REMINDER_BODY_BYTES = 16 * 1024;
const MAX_REMINDERS_PER_HOUR = 5;
const FIREBASE_KEYS_TIMEOUT_MS = 5000;
const EMAIL_SEND_TIMEOUT_MS = 8000;
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

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname === "/api/reminders/email") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store", ...securityHeaders() } });
      return sendEmailReminders(request, env);
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
};
