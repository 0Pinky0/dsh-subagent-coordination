import z from "@deepseek-ai/schemastery";
import { assertObjectJsonSchema, defineTool } from "@deepseek-ai/dsh-tools";
import { errorText, formatReportMessage, normalizeResult, resolveTimeout } from "./core.js";

export const name = "subagent-coordination";
export const inject = ["tools", "subagents", "systemPrompt"];

export const Config = z.object({
  provider: z.string().min(1).default("spawn"),
  maxBatchSize: z.number().step(1).min(1).max(64).default(8),
  maxBatchConcurrency: z.number().step(1).min(1).max(16).default(4),
  defaultTimeoutMs: z.number().step(1).min(0).default(120000),
  maxTimeoutMs: z.number().step(1).min(0).default(900000)
});

const STATUS_VALUES = ["completed", "cancelled", "failed"];
const REPORT_STATUS_VALUES = ["progress", "complete", "blocked", "failed"];
const CHILD_MODE_VALUES = ["one-shot", "continuable"];
const CHILD_ACTIVITY_VALUES = ["running", "inactive"];

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", required: true, enum: STATUS_VALUES },
    stopReason: { type: "string", required: true },
    text: { type: "string", required: true },
    structured: { type: "json" },
    childId: { type: "string" },
    timedOut: { type: "boolean", required: true },
    diagnostic: { type: "string" }
  }
};

const BATCH_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", required: true, enum: ["completed", "partial", "failed", "cancelled"] },
    results: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "number", required: true },
          description: { type: "string", required: true },
          result: { ...RESULT_SCHEMA, required: true }
        }
      }
    },
    completed: { type: "number", required: true },
    failed: { type: "number", required: true },
    cancelled: { type: "number", required: true }
  }
};

const CHILD_ENTRY_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", required: true, enum: ["child"] },
        id: { type: "string", required: true },
        activity: { type: "string", required: true, enum: CHILD_ACTIVITY_VALUES },
        hasChildren: { type: "boolean", required: true },
        mode: { type: "string", required: true, enum: CHILD_MODE_VALUES },
        label: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", required: true, enum: ["diagnostic"] },
        id: { type: "string", required: true },
        reason: { type: "string", required: true, enum: ["corrupt", "unsupported", "unavailable"] }
      }
    }
  ]
};

const STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    children: { type: "array", required: true, items: CHILD_ENTRY_SCHEMA },
    count: { type: "number", required: true }
  }
};

const FINALIZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    finalized: { type: "boolean", required: true },
    mode: { type: "string", required: true, enum: ["all", "selected"] },
    targetIds: { type: "array", required: true, items: { type: "string" } }
  }
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    delivered: { type: "boolean", required: true },
    messageId: { type: "string", required: true },
    parentAgentId: { type: "string", required: true },
    status: { type: "string", required: true, enum: REPORT_STATUS_VALUES }
  }
};

function present(title, kind, rawInput) {
  return { card: "generic", title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}

function requireAgent(exec) {
  if (!exec.agent) throw new Error("subagent-coordination tools require a calling agent");
  return exec.agent;
}

function textBlocks(text) {
  return [{ type: "text", text }];
}

function childAgentOptions(args) {
  const hasProvider = args.child_provider !== undefined;
  const hasModel = args.child_model !== undefined;
  const hasEffort = args.reasoning_effort !== undefined;
  const hasMaxTokens = args.max_tokens !== undefined;
  if (!hasProvider && !hasModel && !hasEffort && !hasMaxTokens) return undefined;
  if (hasProvider && (typeof args.child_provider !== "string" || args.child_provider.length === 0)) throw new Error("child_provider must be non-empty");
  if (hasModel && (typeof args.child_model !== "string" || args.child_model.length === 0)) throw new Error("child_model must be non-empty");
  if (hasMaxTokens && (!Number.isSafeInteger(args.max_tokens) || args.max_tokens < 1)) throw new Error("max_tokens must be a positive safe integer");
  return {
    ...(hasProvider ? { provider: args.child_provider } : {}),
    ...(hasModel ? { model: args.child_model } : {}),
    ...(hasEffort ? { reasoningEffort: args.reasoning_effort } : {}),
    ...(hasMaxTokens ? { maxTokens: args.max_tokens } : {})
  };
}

function outputSchema(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "object") throw new Error("output_schema must be an object-rooted JSON Schema");
  assertObjectJsonSchema(value);
  return value;
}

function linkAbort(source, controller) {
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function observeAbort(signal) {
  let listener;
  const promise = new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    listener = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (listener) signal.removeEventListener("abort", listener);
    }
  };
}

function disposeOnce(run) {
  let disposal;
  return () => {
    if (disposal === undefined) disposal = Promise.resolve().then(() => run.dispose());
    return disposal;
  };
}

async function awaitRunResult(run, signal, dispose) {
  const resultPromise = Promise.resolve(run.result).then(
    (value) => ({ kind: "result", value }),
    (error) => ({ kind: "error", error })
  );
  const abort = observeAbort(signal);
  try {
    const winner = await Promise.race([resultPromise, abort.promise]);
    if (winner.kind !== "aborted") return winner;
    let disposalError;
    try {
      await dispose();
    } catch (error) {
      disposalError = error;
    }
    const terminal = await resultPromise;
    if (disposalError && terminal.kind === "error") throw new AggregateError([disposalError, terminal.error], "subagent cancellation and result both failed");
    if (disposalError) throw disposalError;
    if (terminal.kind === "error") throw terminal.error;
    return { kind: "aborted", terminal: terminal.value };
  } finally {
    abort.cleanup();
  }
}

function cancelledResult(timedOut, run, diagnostic) {
  return {
    status: "cancelled",
    stopReason: "aborted",
    text: "",
    ...(run === undefined ? {} : { childId: run.id }),
    timedOut,
    diagnostic
  };
}

function failedResult(error, timedOut, run) {
  return {
    status: "failed",
    stopReason: "error",
    text: "",
    ...(run === undefined ? {} : { childId: run.id }),
    timedOut,
    diagnostic: errorText(error)
  };
}

async function runOneShot(ctx, parent, args, config, parentSignal, batchSignal) {
  const timeoutMs = resolveTimeout(args.timeout_ms, config.defaultTimeoutMs, config.maxTimeoutMs);
  const options = childAgentOptions(args);
  const schema = outputSchema(args.output_schema);
  const controller = new AbortController();
  const unlinkParent = linkAbort(parentSignal, controller);
  const unlinkBatch = batchSignal ? linkAbort(batchSignal, controller) : () => {};
  let timedOut = false;
  let timer;
  let run;
  let dispose;
  let outcome;
  let primaryError;
  let cleanupError;
  try {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("subagent synchronization timeout"));
      }, timeoutMs);
    }
    run = await ctx.subagents.start(args.provider ?? config.provider, {
      label: args.description,
      prompt: textBlocks(args.prompt),
      parent,
      signal: controller.signal,
      ...(options === undefined ? {} : { agentOptions: options }),
      ...(schema === undefined ? {} : { outputSchema: schema })
    });
    dispose = disposeOnce(run);
    outcome = await awaitRunResult(run, controller.signal, dispose);
    if (outcome.kind === "error") primaryError = outcome.error;
    else if (outcome.kind === "aborted") outcome = { kind: "cancelled" };
    else {
      const normalized = normalizeResult(outcome.value);
      outcome = { kind: "value", value: { ...normalized, childId: run.id, timedOut } };
      if (timedOut || parentSignal.aborted || batchSignal?.aborted) {
        outcome.value.status = "cancelled";
        outcome.value.stopReason = "aborted";
        outcome.value.diagnostic = timedOut ? "synchronization timeout elapsed" : "cancelled by the caller";
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (timer) clearTimeout(timer);
    unlinkParent();
    unlinkBatch();
    if (dispose) {
      try {
        await dispose();
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    if (primaryError) return failedResult(new AggregateError([primaryError, cleanupError], "subagent result and disposal failed"), timedOut, run);
    return failedResult(cleanupError, timedOut, run);
  }
  if (primaryError) {
    if (timedOut || parentSignal.aborted || batchSignal?.aborted) return cancelledResult(timedOut, run, timedOut ? "synchronization timeout elapsed" : "cancelled by the caller");
    return failedResult(primaryError, timedOut, run);
  }
  if (outcome?.kind === "cancelled") return cancelledResult(timedOut, run, timedOut ? "synchronization timeout elapsed" : "cancelled by the caller");
  return outcome.value;
}

function counts(results) {
  return results.reduce((value, item) => {
    if (item.result.status === "completed") value.completed += 1;
    else if (item.result.status === "cancelled") value.cancelled += 1;
    else value.failed += 1;
    return value;
  }, { completed: 0, failed: 0, cancelled: 0 });
}

function batchStatus(summary) {
  if (summary.completed > 0 && (summary.failed > 0 || summary.cancelled > 0)) return "partial";
  if (summary.failed > 0) return "failed";
  if (summary.cancelled > 0) return "cancelled";
  return "completed";
}

function notStartedResult(reason) {
  return { status: "cancelled", stopReason: "aborted", text: "", timedOut: false, diagnostic: reason };
}

function visibleJson(value, maxChars = 32000) {
  let text;
  try {
    text = JSON.stringify(value);
    if (typeof text !== "string") text = String(text);
  } catch {
    text = JSON.stringify({ status: "failed", diagnostic: "result could not be serialized" });
  }
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[rendered result truncated; inspect the canonical tool result for the full value]";
}

function renderResult(_args, value) {
  return [{ type: "text", text: visibleJson(value) }];
}

function renderBatch(_args, value) {
  return [{ type: "text", text: visibleJson(value) }];
}

function normalizeChildEntry(entry) {
  if (entry.kind === "diagnostic") return { kind: "diagnostic", id: entry.id, reason: entry.reason };
  return {
    kind: "child",
    id: entry.id,
    activity: entry.activity,
    hasChildren: entry.hasChildren,
    mode: entry.mode,
    ...(entry.label === undefined ? {} : { label: entry.label })
  };
}

function validateBatchArgs(args, config) {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error("tasks must contain at least one item");
  if (args.tasks.length > config.maxBatchSize) throw new Error("tasks exceeds maxBatchSize of " + config.maxBatchSize);
  resolveTimeout(args.timeout_ms, config.defaultTimeoutMs, config.maxTimeoutMs);
  for (const task of args.tasks) {
    childAgentOptions(task);
    outputSchema(task.output_schema);
  }
}

async function runBatch(ctx, parent, args, config, signal) {
  validateBatchArgs(args, config);
  const batchController = new AbortController();
  const unlink = linkAbort(signal, batchController);
  const results = new Array(args.tasks.length);
  let nextIndex = 0;
  let failFastTriggered = false;
  const worker = async () => {
    while (true) {
      if (batchController.signal.aborted) return;
      const index = nextIndex++;
      if (index >= args.tasks.length) return;
      const task = args.tasks[index];
      let result;
      try {
        result = await runOneShot(ctx, parent, { ...task, timeout_ms: args.timeout_ms }, config, signal, batchController.signal);
      } catch (error) {
        result = failedResult(error, false);
      }
      results[index] = { index, description: task.description, result };
      if (args.fail_fast === true && result.status !== "completed") {
        failFastTriggered = true;
        batchController.abort(new Error("subagent batch fail-fast"));
        return;
      }
    }
  };
  try {
    const workerCount = Math.min(config.maxBatchConcurrency, args.tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    unlink();
  }
  const missingReason = failFastTriggered ? "not started because fail_fast cancelled the batch" : "not started because the batch was cancelled";
  for (let index = 0; index < results.length; index += 1) {
    if (results[index] === undefined) results[index] = { index, description: args.tasks[index].description, result: notStartedResult(missingReason) };
  }
  const summary = counts(results);
  return { status: batchStatus(summary), results, ...summary };
}

export function apply(ctx, config = {}) {
  const resolved = {
    provider: config.provider ?? "spawn",
    maxBatchSize: config.maxBatchSize ?? 8,
    maxBatchConcurrency: config.maxBatchConcurrency ?? 4,
    defaultTimeoutMs: config.defaultTimeoutMs ?? 120000,
    maxTimeoutMs: config.maxTimeoutMs ?? 900000
  };
  if (typeof resolved.provider !== "string" || resolved.provider.length === 0) throw new Error("provider must be a non-empty string");
  if (!Number.isSafeInteger(resolved.maxBatchSize) || resolved.maxBatchSize < 1) throw new Error("maxBatchSize must be a positive safe integer");
  if (!Number.isSafeInteger(resolved.maxBatchConcurrency) || resolved.maxBatchConcurrency < 1) throw new Error("maxBatchConcurrency must be a positive safe integer");
  if (!Number.isSafeInteger(resolved.defaultTimeoutMs) || resolved.defaultTimeoutMs < 0) throw new Error("defaultTimeoutMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(resolved.maxTimeoutMs) || resolved.maxTimeoutMs < resolved.defaultTimeoutMs) throw new Error("maxTimeoutMs must be at least defaultTimeoutMs");

  ctx.systemPrompt.section({
    name: "tool:subagent-coordination",
    order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") + 1,
    text: "Use subagent_sync when the next decision depends on one child result: it waits for a terminal one-shot result and releases the child. Set output_schema to an object-rooted JSON Schema when the child must return validated structured data. Use subagent_batch for independent tasks that must be joined before you continue; it preserves task order, bounds concurrency, and can fail fast. Use report_to_parent from a child for a versioned JSON handoff; delivery does not end that child turn. delegation_status reports durable children but activity is not completion. Use delegation_finalize explicitly for continuable children that no longer matter. The all=true form is terminal for the current parent's continuable admission, so call it at the end of that parent's lifecycle."
  });

  ctx.tools.register(defineTool({
    name: "subagent_sync",
    description: "Delegate one self-contained task and wait for its terminal result. The child is always disposed after collection, including failure, cancellation, and timeout. Set output_schema to an object-rooted JSON Schema to request validated structured output.",
    parameters: {
      description: { type: "string", required: true, description: "A short 3-5 word task label." },
      prompt: { type: "string", required: true, description: "A complete self-contained task for the child." },
      provider: { type: "string", description: "Named DSH subagent provider; defaults to the plugin provider." },
      child_provider: { type: "string", description: "Optional child LLM provider route; omitted values inherit the parent route." },
      child_model: { type: "string", description: "Optional child LLM model; omitted values inherit the parent route." },
      reasoning_effort: { type: "string", description: "Optional child reasoning effort; omitted provider/model fields inherit the parent route." },
      max_tokens: { type: "number", description: "Optional positive child output-token limit; omitted route fields inherit the parent options." },
      timeout_ms: { type: "number", description: "Per-child timeout in milliseconds." },
      output_schema: { type: "json", description: "Optional object-rooted raw JSON Schema for validated structured child output." }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return runOneShot(ctx, requireAgent(exec), args, resolved, exec.signal);
    },
    presentCall: (args) => present("Run synchronous subagent", "execute", args.description)
  }));

  ctx.tools.register(defineTool({
    name: "subagent_batch",
    description: "Run independent one-shot subagent tasks with bounded parallelism and wait for the complete ordered batch. Every started child is disposed after collection. Set fail_fast to cancel unfinished siblings after the first non-completed result.",
    parameters: {
      tasks: {
        type: "array",
        required: true,
        description: "Independent tasks to run in parallel.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: "string", required: true },
            prompt: { type: "string", required: true },
            provider: { type: "string" },
            child_provider: { type: "string" },
            child_model: { type: "string" },
            reasoning_effort: { type: "string" },
            max_tokens: { type: "number" },
            output_schema: { type: "json" }
          }
        }
      },
      timeout_ms: { type: "number", description: "Per-child timeout in milliseconds." },
      fail_fast: { type: "boolean", description: "Cancel unfinished siblings after the first failed or cancelled child." }
    },
    output: { schema: BATCH_RESULT_SCHEMA, render: renderBatch },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return runBatch(ctx, requireAgent(exec), args, resolved, exec.signal);
    },
    presentCall: (args) => present("Run subagent batch", "execute", args.tasks.map((task) => task.description).join(", "))
  }));

  ctx.tools.register(defineTool({
    name: "report_to_parent",
    description: "Send a versioned structured progress or completion report to this child agent's direct parent. This delivers a JSON handoff but does not end the current child turn.",
    parameters: {
      status: { type: "string", required: true, enum: REPORT_STATUS_VALUES },
      summary: { type: "string", required: true },
      details: { type: "string" },
      next_actions: { type: "array", items: { type: "string" } }
    },
    output: { schema: REPORT_SCHEMA, render: (_args, value) => [{ type: "text", text: visibleJson(value) }] },
    async execute(args, exec) {
      const child = requireAgent(exec);
      const parentId = child.session?.header?.parentSession;
      if (!parentId) throw new Error("report_to_parent requires a child with a direct parent session");
      const messageId = await ctx.subagents.sendMessage(child, parentId, textBlocks(formatReportMessage({ status: args.status, summary: args.summary, details: args.details, nextActions: args.next_actions })), { signal: exec.signal });
      return { delivered: true, messageId, parentAgentId: parentId, status: args.status };
    },
    presentCall: (args) => present("Report to parent", "other", args.summary)
  }));

  ctx.tools.register(defineTool({
    name: "delegation_status",
    description: "List this agent's durable direct subagent entries, including one-shot and continuable modes. This is an observation tool, not completion polling; activity is not a terminal outcome.",
    parameters: {},
    output: { schema: STATUS_SCHEMA, render: (_args, value) => [{ type: "text", text: visibleJson(value) }] },
    async execute(_args, exec) {
      const parent = requireAgent(exec);
      const entries = await ctx.subagents.listChildren(parent.id, exec.signal);
      const children = entries.map(normalizeChildEntry);
      return { children, count: children.length };
    },
    presentCall: () => present("Read delegation status", "read")
  }));

  ctx.tools.register(defineTool({
    name: "delegation_finalize",
    description: "Explicitly stop and release continuable children. Set all=true to drain all live continuable descendants at the end of this parent's lifecycle, or provide child_ids to release selected direct continuable children. Unknown or one-shot ids are rejected.",
    parameters: {
      all: { type: "boolean", description: "Drain all live continuable descendants; this closes continuable admission for the current parent until it leaves the registry." },
      child_ids: { type: "array", items: { type: "string" }, description: "Selected direct continuable child ids to release." }
    },
    output: { schema: FINALIZE_SCHEMA, render: (_args, value) => [{ type: "text", text: visibleJson(value) }] },
    async execute(args, exec) {
      const parent = requireAgent(exec);
      if (args.all === true) {
        const entries = await ctx.subagents.listDescendants(parent.id, exec.signal);
        const targetIds = entries.filter((entry) => entry.kind === "child" && entry.mode === "continuable" && entry.activity === "running").map((entry) => entry.id);
        await ctx.subagents.drainContinuableDescendants([parent]);
        return { finalized: true, mode: "all", targetIds };
      }
      const targetIds = [...new Set(args.child_ids ?? [])];
      if (targetIds.length === 0) throw new Error("provide child_ids or set all=true");
      const entries = await ctx.subagents.listChildren(parent.id, exec.signal);
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      for (const id of targetIds) {
        const entry = byId.get(id);
        if (!entry || entry.kind !== "child" || entry.mode !== "continuable") throw new Error("child_id " + id + " is not a known direct continuable child");
      }
      await ctx.subagents.drainContinuableChildren(parent, targetIds);
      return { finalized: true, mode: "selected", targetIds };
    },
    presentCall: (args) => present("Finalize delegated work", "execute", args.all === true ? "all descendants" : (args.child_ids ?? []).join(", "))
  }));
}

export default { name, inject, Config, apply };
