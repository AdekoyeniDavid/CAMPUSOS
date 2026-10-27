import test from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/index.js";

test("push configuration exposes only the public application server key", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/push/config"), {
    PUSH_VAPID_PUBLIC_KEY: "public-key",
    PUSH_VAPID_PRIVATE_KEY: "private-key-must-not-leak",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { publicKey: "public-key", configured: true });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("push configuration is available but reports background delivery as unconfigured", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/push/config"), {
    PUSH_VAPID_PUBLIC_KEY: "public-key",
  });
  assert.deepEqual(await response.json(), { publicKey: "public-key", configured: false });
});

test("push subscription rejects unauthenticated requests", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/example", keys: { p256dh: "x", auth: "y" } } }),
  }), { FIREBASE_PROJECT_ID: "campusos-f5cfc" });
  assert.equal(response.status, 401);
});

test("push reminder actions enforce their HTTP methods", async () => {
  const response = await worker.fetch(new Request("https://campusos.example/api/reminders/push/send"), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
});
