import test from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../src/planner.js";

test("parses a supported Gemini action", () => {
  assert.deepEqual(parsePlan('{"tool":"payment.refund","args":{"amount":75,"payment_id":"p1"},"explanation":"Refund requested"}'), {
    tool: "payment.refund", args: { amount: 75, payment_id: "p1" }, explanation: "Refund requested",
  });
});

test("rejects tools outside the constrained catalog", () => {
  assert.throws(() => parsePlan('{"tool":"database.drop","args":{}}'), /unsupported tool/);
});
