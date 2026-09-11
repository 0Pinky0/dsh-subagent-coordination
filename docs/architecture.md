# Architecture Notes

## Ownership

The plugin is a consumer of the public ctx.subagents seam. It does not patch DSH internals, replace the existing continuable tool, or infer completion from public lifecycle events. One-shot ownership is local to each call: the plugin receives a published SubagentRun, awaits its result, and releases that run in a finally path.

## Result path

subagent_sync and each batch task create an operation-local AbortController. The caller signal, batch fail-fast signal, and deadline all feed that controller. A deadline/cancellation first disposes the run, then waits for the authoritative result promise before returning a cancellation envelope. A successful result preserves text, structured capture, stop reason, child id, and diagnostics.

Batch workers claim indexes synchronously, cap active starts, preserve result order, and await all workers. Fail-fast stops new claims and aborts active children; missing indexes are materialized as cancelled entries so partial work is explicit.

## Continuable path

report_to_parent is intentionally a delivery adapter over ctx.subagents.sendMessage. The parent id comes from the child's durable session header, so a non-child agent cannot impersonate a parent route. The JSON payload is versioned for future schema evolution, while the tool result reports only delivery.

delegation_finalize uses drainContinuableChildren for selected direct children and drainContinuableDescendants for the all-descendants operation. The latter closes admission for the exact parent's lineage until that parent leaves the registry; this is why the system prompt and documentation make all: true a lifecycle-finalization operation, not a routine polling action.
