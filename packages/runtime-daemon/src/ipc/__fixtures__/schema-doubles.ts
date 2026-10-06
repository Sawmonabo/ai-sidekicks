// `ZodType` doubles shared by the IPC test suites. The registry only reads `safeParse`, so each
// double implements only that and no real schema is built.

import type { ZodType } from "@ai-sidekicks/contracts/jsonrpc/registry";

/** Schema mock that accepts any input as `{ success: true, data }`. */
export function passthroughSchema<T>(): ZodType<T> {
  return {
    safeParse: (v: unknown): { success: true; data: T } => ({
      success: true,
      data: v as T,
    }),
  } as unknown as ZodType<T>;
}

/**
 * Schema mock that rejects any input in the shape `MethodRegistryImpl.dispatch` reads. Its single
 * `issues` entry carries `marker` so a test can assert on it.
 */
export function rejectingSchema<T>(marker: string): ZodType<T> {
  return {
    safeParse: (_v: unknown): { success: false; error: { issues: ReadonlyArray<unknown> } } => ({
      success: false,
      error: { issues: [{ marker, message: "test-rejection" }] },
    }),
  } as unknown as ZodType<T>;
}
