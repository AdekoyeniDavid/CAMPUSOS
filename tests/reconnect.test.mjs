import test from "node:test";
import assert from "node:assert/strict";
import { watchWithReconnect } from "../src/reconnect.ts";

test("cloud subscriptions reconnect automatically after a transient listener failure", async () => {
  let attempts = 0;
  let stoppedSubscriptions = 0;
  const errors = [];
  const recovered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("subscription did not reconnect")), 2_000);
    const stop = watchWithReconnect((next, error) => {
      attempts += 1;
      if (attempts === 1) {
        setTimeout(() => error(new Error("temporary network failure")), 0);
      } else {
        setTimeout(() => next("connected"), 0);
      }
      return () => { stoppedSubscriptions += 1; };
    }, (value) => {
      clearTimeout(timeout);
      resolve({ value, stop });
    }, (error) => errors.push(error), { initialDelayMs: 100, maxDelayMs: 200 });
  });

  const { value, stop } = await recovered;
  stop();
  assert.equal(value, "connected");
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(stoppedSubscriptions, 2);
});
