import test from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/index.js";

test("email reminder endpoint rejects unauthenticated requests", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reminders: [{ title: "Essay", course: "BIO 101", due: "30 Oct" }] }),
  }), { FIREBASE_PROJECT_ID: "campusos-f5cfc" });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /verified email/i);
});

test("email reminder endpoint allows only POST", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/email"), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
});

test("email reminder endpoint rejects cross-origin requests", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/email", {
    method: "POST",
    headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
    body: JSON.stringify({ reminders: [{ title: "Essay", course: "BIO 101", due: "30 Oct" }] }),
  }), { FIREBASE_PROJECT_ID: "campusos-f5cfc" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
