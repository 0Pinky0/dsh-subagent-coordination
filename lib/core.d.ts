export type NormalizedStatus = "completed" | "cancelled" | "failed";
export interface NormalizedResult {
  status: NormalizedStatus;
  stopReason: string;
  text: string;
  structured?: unknown;
  diagnostic?: string;
}
export declare function contentText(content: unknown): string;
export declare function normalizeResult(result: unknown): NormalizedResult;
export declare function formatReportMessage(input: { status: string; summary: string; details?: string; nextActions?: string[] }): string;
export declare function errorText(error: unknown): string;
export declare function resultFailureText(result: { stopReason: string; diagnostic?: string; text?: string }): string;
export declare function resolveTimeout(value: unknown, fallback: number, maximum: number): number;
export declare function countBatchResults(results: readonly { status: string }[]): { completed: number; failed: number; cancelled: number };
export declare const SUCCESS_STOP_REASON: "completed";
