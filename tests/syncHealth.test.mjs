import test from "node:test";
import assert from "node:assert/strict";
import { isCloudRealtimeConnected } from "../src/syncHealth.ts";

test("cloud status is connected only when all required live subscriptions are healthy", () => {
  assert.equal(isCloudRealtimeConnected(true, 8, 8), true);
  assert.equal(isCloudRealtimeConnected(true, 7, 8), false);
  assert.equal(isCloudRealtimeConnected(false, 8, 8), false);
  assert.equal(isCloudRealtimeConnected(true, 8, 0), false);
});
