import test from "node:test";
import assert from "node:assert/strict";
import {
  contentText,
  countBatchResults,
  formatReportMessage,
  normalizeResult,
  resolveTimeout
} from "../lib/core.js";

test("normalizes mixed content and structured result", () => {
  assert.equal(contentText([{ type: "text", text: "a" }, { type: "thinking", text: "hidden" }, { type: "text", text: "b" }]), "ab");
  assert.deepEqual(normalizeResult({
    stopReason: "completed",
    output: [{ type: "text", text: "done" }],
    structured: { answer: 42 }
  }), {
    status: "completed",
    stopReason: "completed",
    text: "done",
    structured: { answer: 42 }
  });
});

test("formats a versioned parent handoff and counts batch outcomes", () => {
  const report = JSON.parse(formatReportMessage({
    status: "complete",
    summary: "Review finished",
    details: "No regressions found",
    nextActions: ["Merge the patch"]
  }));
  assert.deepEqual(report, {
    type: "dsh/subagent-report",
    version: 1,
    status: "complete",
    summary: "Review finished",
    details: "No regressions found",
    nextActions: ["Merge the patch"]
  });
  assert.deepEqual(countBatchResults([{ status: "completed" }, { status: "failed" }, { status: "cancelled" }]), {
    completed: 1,
    failed: 1,
    cancelled: 1
  });
});

test("enforces bounded timeouts", () => {
  assert.equal(resolveTimeout(undefined, 10, 20), 10);
  assert.equal(resolveTimeout(20, 10, 20), 20);
  assert.throws(() => resolveTimeout(-1, 10, 20), /non-negative/);
  assert.throws(() => resolveTimeout(21, 10, 20), /maximum/);
});
