# DSH Subagent Coordination Plugin

A loadable Cordis plugin for DSH that adds explicit synchronization around one-shot delegation, bounded batch joins, structured parent handoffs, and intentional continuable-child cleanup.

## Scope

This MVP does not change DSH's existing subagent tool or its continuable semantics. It uses the public ctx.subagents service:

- subagent_sync starts a one-shot child, waits for run.result, returns a stable result envelope, and always calls run.dispose().
- subagent_batch runs independent one-shot tasks with a configurable concurrency cap, preserves input order, and optionally cancels siblings on the first non-completed result.
- report_to_parent sends a versioned JSON handoff from a resident continuable child to its direct parent. Delivery is not an acknowledgment and does not end the child turn.
- delegation_status lists durable direct children and clearly reports activity, mode, label, and diagnostics. Activity is not completion.
- delegation_finalize explicitly releases selected direct continuable children or all live continuable descendants. It never runs automatically at every idle transition.

## Compatibility

The package targets the public DSH 0.1.5-rc.2 service contracts and Node.js >=22. Keep these packages on the same DSH release line:

- @deepseek-ai/cordis ^4.0.2
- @deepseek-ai/dsh-agent, @deepseek-ai/dsh-llm, @deepseek-ai/dsh-subagent, @deepseek-ai/dsh-system-prompt, and @deepseek-ai/dsh-tools ^0.1.5-rc.2
- @deepseek-ai/schemastery ^3.18.2

This repository has no remote publication step. Install it from a local checkout or package tarball after building it.

## Install

From this repository:

    npm install

For a local profile, add the package to the profile's dependency environment or use a loader-visible absolute path. Then add one of the rows below. The plugin needs tools, subagents, and systemPrompt; the subagent registry and one-shot provider remain host-owned.

### Host composition

Use this when the plugin should register tools for the host's agent composition:

    - id: subagent-coordination
      name: /absolute/path/to/dsh-subagent-coordination
      config:
        provider: spawn
        maxBatchSize: 8
        maxBatchConcurrency: 4
        defaultTimeoutMs: 120000
        maxTimeoutMs: 900000

### Agent preset composition

For Web sessions, model-facing tools normally belong in the selected agent preset. Add the same row inside the preset's delegation group (or another group that already resolves tools, subagents, and systemPrompt):

    - id: subagent-coordination
      name: /absolute/path/to/dsh-subagent-coordination
      config:
        provider: spawn
        maxBatchSize: 8
        maxBatchConcurrency: 4

Do not create a second subagents registry or provider in the preset. The service is host-owned; only this plugin's tool registrations should move behind the preset boundary.

## Tool usage

### Synchronous result

Use subagent_sync when the parent must make a decision from a child result in the same turn:

    subagent_sync({
      description: "Review API boundary",
      prompt: "Inspect the specified API and return concrete risks.",
      output_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          risks: { type: "array", items: { type: "string" } },
          safe: { type: "boolean" }
        },
        required: ["risks", "safe"]
      }
    })

output_schema is an object-rooted raw JSON Schema accepted by DSH's supported subset: type, properties, required, additionalProperties, items, enum, const, oneOf, and annotations. The plugin returns the provider's validated value in result.structured when the child captures it. A schema request does not make a failed or incomplete child successful.

The returned status is one of completed, cancelled, or failed; stopReason preserves DSH's terminal reason, and timedOut distinguishes the plugin deadline. Native rendering includes the bounded JSON envelope, so structured values and child ids remain visible without relying on PTC.

### Batch join

Use subagent_batch for independent tasks. The result contains ordered { index, description, result } entries plus completed, failed, and cancelled counts. maxBatchConcurrency bounds started children; fail_fast: true cancels running siblings and marks queued tasks as cancelled without starting them.

### Structured handoff

A continuable child can call report_to_parent:

    report_to_parent({
      status: "complete",
      summary: "Implementation is ready",
      details: "Tests pass and no files remain untracked.",
      next_actions: ["Review the diff"]
    })

The delivered content is a versioned JSON object with type: "dsh/subagent-report" and version: 1. The call only confirms inbox delivery (messageId); it is not a join barrier, acknowledgment, or turn finalizer. One-shot children should return through subagent_sync or subagent_batch instead.

### Explicit cleanup

Use delegation_status to inspect direct children. running/inactive, one-shot/continuable, and label are observation facts, not result states.

Use delegation_finalize with child_ids for selected direct continuable children. Use all: true only when the current parent is finishing its lifecycle: DSH closes continuable admission below that exact live parent during the drain. The plugin never treats send_message, idle, or ready as completion and never auto-kills children on turn/end.

## Failure and cancellation semantics

- Caller cancellation is propagated to every started one-shot run.
- The per-child deadline aborts the run, waits for the run's result/disposal path, and returns cancelled with timedOut: true.
- Every published one-shot run is disposed exactly once by the plugin, including child failure, caller cancellation, timeout, batch fail-fast, and disposal failure.
- Batch results are returned after all started children have reached the plugin's cleanup boundary; queued fail-fast items are explicit cancelled entries.
- An infrastructure failure is represented as failed with a bounded diagnostic; child-level DSH stop reasons remain in stopReason.

## Development

The test suite uses a deterministic mock ctx.subagents runtime plus the real DSH defineTool schema compiler. With DSH dependencies available:

    npm run build
    npm test
    npm run check
    npm run pack:check

The repository's local node_modules link is only for local validation and is ignored by Git. A live authenticated Web GUI installation was not performed by this MVP.
