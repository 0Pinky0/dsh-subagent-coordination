import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const STRUCTURED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answer: { type: "string" } },
  required: ["answer"]
};

function parentAgent(id = "parent") {
  return { id, session: { header: { parentSession: undefined } } };
}

function mount(subagents, config = {}) {
  const definitions = new Map();
  const sections = [];
  const ctx = {
    subagents,
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      }
    },
    systemPrompt: {
      getSectionOrder() { return 2800; },
      section(value) { sections.push(value); return () => {}; }
    }
  };
  apply(ctx, {
    provider: "spawn",
    maxBatchSize: 8,
    maxBatchConcurrency: 2,
    defaultTimeoutMs: 100,
    maxTimeoutMs: 1000,
    ...config
  });
  return { definitions, sections };
}

function exec(agent, signal = new AbortController().signal) {
  return { agent, signal };
}

function completedRun(id, request, value = "ok") {
  let disposeCount = 0;
  return {
    run: {
      id,
      localAgent: undefined,
      result: Promise.resolve({
        stopReason: "completed",
        output: [{ type: "text", text: value }],
        structured: { answer: value }
      }),
      async dispose() { disposeCount += 1; }
    },
    get disposeCount() { return disposeCount; },
    request
  };
}

test("registers all coordination tools through defineTool", () => {
  const { definitions, sections } = mount({});
  assert.deepEqual([...definitions.keys()].sort(), [
    "delegation_finalize",
    "delegation_status",
    "report_to_parent",
    "subagent_batch",
    "subagent_sync"
  ]);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /output_schema/);
});

test("subagent_sync waits for structured output and disposes exactly once", async () => {
  let captured;
  let created;
  const subagents = {
    async start(provider, request) {
      captured = { provider, request };
      created = completedRun("child-1", request, "structured answer");
      return created.run;
    }
  };
  const { definitions } = mount(subagents);
  const result = await definitions.get("subagent_sync").execute({
    description: "Review task",
    prompt: "Return the requested review.",
    output_schema: STRUCTURED_SCHEMA
  }, exec(parentAgent()));
  assert.equal(captured.provider, "spawn");
  assert.equal(captured.request.prompt[0].text, "Return the requested review.");
  assert.deepEqual(captured.request.outputSchema, STRUCTURED_SCHEMA);
  assert.deepEqual(result, {
    status: "completed",
    stopReason: "completed",
    text: "structured answer",
    structured: { answer: "structured answer" },
    childId: "child-1",
    timedOut: false
  });
  assert.equal(created.disposeCount, 1);
  assert.equal(definitions.get("subagent_sync").output.render({}, result)[0].text, JSON.stringify(result));
});

test("subagent_sync converts timeout into cancellation and still disposes", async () => {
  let disposed = 0;
  const subagents = {
    async start() {
      let settle;
      const result = new Promise((resolve) => { settle = resolve; });
      return {
        id: "slow-child",
        localAgent: undefined,
        result,
        async dispose() {
          disposed += 1;
          settle({ stopReason: "aborted", output: [] });
        }
      };
    }
  };
  const { definitions } = mount(subagents, { defaultTimeoutMs: 5 });
  const result = await definitions.get("subagent_sync").execute({
    description: "Timeout task",
    prompt: "This will not settle.",
    timeout_ms: 5
  }, exec(parentAgent()));
  assert.equal(result.status, "cancelled");
  assert.equal(result.timedOut, true);
  assert.equal(result.stopReason, "aborted");
  assert.equal(disposed, 1);
});

test("subagent_sync propagates caller cancellation to the published child", async () => {
  const caller = new AbortController();
  let childSignal;
  let disposed = 0;
  const subagents = {
    async start(_provider, request) {
      childSignal = request.signal;
      const result = new Promise((resolve) => {
        request.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", output: [] }), { once: true });
      });
      return { id: "cancelled-child", localAgent: undefined, result, async dispose() { disposed += 1; } };
    }
  };
  const { definitions } = mount(subagents, { defaultTimeoutMs: 500 });
  const pending = definitions.get("subagent_sync").execute({
    description: "Cancelled task",
    prompt: "Wait for cancellation."
  }, exec(parentAgent(), caller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort(new Error("caller stopped the delegation"));
  const result = await pending;
  assert.equal(childSignal.aborted, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.timedOut, false);
  assert.equal(disposed, 1);
});

test("subagent_batch bounds concurrency and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  let sequence = 0;
  const disposed = [];
  const subagents = {
    async start(_provider, request) {
      const index = Number(request.label.split("-")[1]);
      active += 1;
      peak = Math.max(peak, active);
      const id = "batch-child-" + sequence++;
      const result = new Promise((resolve) => setTimeout(() => {
        active -= 1;
        resolve({ stopReason: "completed", output: [{ type: "text", text: request.label }] });
      }, index === 0 ? 12 : 2));
      return { id, localAgent: undefined, result, async dispose() { disposed.push(id); } };
    }
  };
  const { definitions } = mount(subagents, { maxBatchConcurrency: 2 });
  const result = await definitions.get("subagent_batch").execute({
    tasks: [0, 1, 2, 3].map((index) => ({ description: "task-" + index, prompt: "work" })),
    timeout_ms: 200
  }, exec(parentAgent()));
  assert.equal(peak, 2);
  assert.deepEqual(result.results.map((entry) => entry.index), [0, 1, 2, 3]);
  assert.deepEqual(result.results.map((entry) => entry.result.text), ["task-0", "task-1", "task-2", "task-3"]);
  assert.equal(result.status, "completed");
  assert.equal(result.completed, 4);
  assert.equal(disposed.length, 4);
  const rendered = JSON.parse(definitions.get("subagent_batch").output.render({}, result)[0].text);
  assert.deepEqual(rendered.results.map((entry) => entry.index), [0, 1, 2, 3]);
});

test("subagent_batch fail_fast cancels running siblings and skips queued work", async () => {
  let starts = 0;
  const disposed = [];
  const subagents = {
    async start(_provider, request) {
      starts += 1;
      const fail = request.label === "fail";
      const result = new Promise((resolve) => {
        let done = false;
        const finish = (value) => { if (!done) { done = true; resolve(value); } };
        request.signal.addEventListener("abort", () => finish({ stopReason: "aborted", output: [] }), { once: true });
        setTimeout(() => finish(fail ? { stopReason: "error", output: [], diagnostic: "expected failure" } : { stopReason: "completed", output: [{ type: "text", text: request.label }] }), fail ? 5 : 100);
      });
      return { id: "child-" + starts, localAgent: undefined, result, async dispose() { disposed.push(request.label); } };
    }
  };
  const { definitions } = mount(subagents, { maxBatchConcurrency: 2 });
  const result = await definitions.get("subagent_batch").execute({
    tasks: ["fail", "slow", "queued"].map((description) => ({ description, prompt: "work" })),
    fail_fast: true,
    timeout_ms: 500
  }, exec(parentAgent()));
  assert.equal(starts, 2);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].result.status, "failed");
  assert.equal(result.results[1].result.status, "cancelled");
  assert.equal(result.results[2].result.status, "cancelled");
  assert.equal(result.failed, 1);
  assert.equal(result.cancelled, 2);
  assert.equal(result.status, "failed");
  assert.deepEqual(disposed.sort(), ["fail", "slow"]);
});

test("report_to_parent sends a versioned JSON handoff", async () => {
  let delivered;
  const subagents = {
    async sendMessage(sender, target, content, options) {
      delivered = { sender, target, content, options };
      return "message-1";
    }
  };
  const { definitions } = mount(subagents);
  const child = { id: "child", session: { header: { parentSession: "parent" } } };
  const result = await definitions.get("report_to_parent").execute({
    status: "complete",
    summary: "Finished the implementation",
    details: "Tests pass",
    next_actions: ["Review the diff"]
  }, exec(child));
  assert.deepEqual(result, { delivered: true, messageId: "message-1", parentAgentId: "parent", status: "complete" });
  assert.equal(delivered.sender, child);
  assert.equal(delivered.target, "parent");
  assert.deepEqual(JSON.parse(delivered.content[0].text), {
    type: "dsh/subagent-report",
    version: 1,
    status: "complete",
    summary: "Finished the implementation",
    details: "Tests pass",
    nextActions: ["Review the diff"]
  });
  assert.equal(delivered.options.signal.aborted, false);
  assert.deepEqual(JSON.parse(definitions.get("report_to_parent").output.render({}, result)[0].text), result);
});

test("delegation_status and delegation_finalize expose explicit cleanup", async () => {
  const calls = [];
  const subagents = {
    async listChildren() {
      return [
        { kind: "child", id: "one-shot", activity: "inactive", hasChildren: false, mode: "one-shot" },
        { kind: "child", id: "continuable", activity: "running", hasChildren: true, mode: "continuable", label: "Long task" }
      ];
    },
    async listDescendants() {
      return [{ kind: "child", id: "continuable", activity: "running", hasChildren: false, mode: "continuable", label: "Long task" }];
    },
    async drainContinuableChildren(parent, ids) { calls.push(["children", parent, ids]); },
    async drainContinuableDescendants(parents) { calls.push(["descendants", parents]); }
  };
  const { definitions } = mount(subagents);
  const parent = parentAgent();
  const status = await definitions.get("delegation_status").execute({}, exec(parent));
  assert.deepEqual(status.children[1], { kind: "child", id: "continuable", activity: "running", hasChildren: true, mode: "continuable", label: "Long task" });
  assert.match(definitions.get("delegation_status").output.render({}, status)[0].text, /continuable/);
  const selected = await definitions.get("delegation_finalize").execute({ child_ids: ["continuable"] }, exec(parent));
  assert.deepEqual(selected, { finalized: true, mode: "selected", targetIds: ["continuable"] });
  assert.deepEqual(calls[0], ["children", parent, ["continuable"]]);
  const all = await definitions.get("delegation_finalize").execute({ all: true }, exec(parent));
  assert.deepEqual(all, { finalized: true, mode: "all", targetIds: ["continuable"] });
  assert.deepEqual(calls[1], ["descendants", [parent]]);
  assert.deepEqual(JSON.parse(definitions.get("delegation_finalize").output.render({}, all)[0].text), all);
});
