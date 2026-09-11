const SUCCESS_STOP_REASON = "completed";

export function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

export function normalizeResult(result) {
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "error";
  const status = stopReason === SUCCESS_STOP_REASON ? "completed" : stopReason === "aborted" ? "cancelled" : "failed";
  const normalized = { status, stopReason, text: contentText(result?.output) };
  if (result && typeof result === "object" && result.structured !== undefined) normalized.structured = result.structured;
  if (typeof result?.diagnostic === "string" && result.diagnostic.length > 0) normalized.diagnostic = result.diagnostic;
  return normalized;
}

export function formatReportMessage(input) {
  const report = {
    type: "dsh/subagent-report",
    version: 1,
    status: input.status,
    summary: input.summary
  };
  if (input.details) report.details = input.details;
  if (Array.isArray(input.nextActions) && input.nextActions.length > 0) report.nextActions = input.nextActions;
  return JSON.stringify(report);
}

export function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

export function resultFailureText(result) {
  const detail = result.diagnostic ? " Diagnostic: " + result.diagnostic : "";
  const partial = result.text ? " Partial output: " + result.text : "";
  return "subagent stopped with " + result.stopReason + "." + detail + partial;
}

export function resolveTimeout(value, fallback, maximum) {
  const timeout = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error("timeout_ms must be a non-negative safe integer");
  if (timeout > maximum) throw new Error("timeout_ms exceeds configured maximum of " + maximum + " ms");
  return timeout;
}

export function countBatchResults(results) {
  return results.reduce((counts, result) => {
    if (result.status === "completed") counts.completed += 1;
    else if (result.status === "cancelled") counts.cancelled += 1;
    else counts.failed += 1;
    return counts;
  }, { completed: 0, failed: 0, cancelled: 0 });
}

export { SUCCESS_STOP_REASON };
