const FIRESTORE_HOST = "firestore.googleapis.com";
const FIRESTORE_RPC_PREFIX = "/google.firestore.v1.Firestore/";

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
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store, max-age=0" });
  if (origin) {
    for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  }
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
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
