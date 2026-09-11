import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

export interface CoordinationConfig {
  provider?: string;
  maxBatchSize?: number;
  maxBatchConcurrency?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}
export declare const name: "subagent-coordination";
export declare const inject: readonly ["tools", "subagents", "systemPrompt"];
export declare const Config: z<CoordinationConfig>;
export declare function apply(ctx: Context, config?: CoordinationConfig): void;
export * from "./core.js";
