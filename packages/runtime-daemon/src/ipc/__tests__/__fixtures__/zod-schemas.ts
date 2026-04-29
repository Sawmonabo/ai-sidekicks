// Test fixtures shared across IPC test suites.
//
// Daemon's `package.json` deliberately does NOT depend on `zod` (every
// runtime-daemon source file routes `ZodType` as a TYPE-ONLY import via
// `@ai-sidekicks/contracts`). The test surface follows the same posture:
// these duck-typed mocks satisfy `ZodType<T>` via a `safeParse` shape-
// match without pulling zod into the test classpath.

import type { ZodType } from "@ai-sidekicks/contracts";

/**
 * Pass-through schema mock — returns `{ success: true, data }` for any
 * input. Sufficient for tests that exercise framing/transport/dispatch
 * wiring rather than schema validation specifically.
 */
export function passthroughSchema<T>(): ZodType<T> {
  return {
    safeParse: (v: unknown): { success: true; data: T } => ({
      success: true,
      data: v as T,
    }),
  } as unknown as ZodType<T>;
}

/**
 * Schema mock that rejects any input with a synthetic
 * `{ success: false, error: { issues: [...] } }` shape matching what
 * `MethodRegistryImpl.dispatch` reads. The `issues` array carries a
 * single marker entry tests can assert on.
 */
export function rejectingSchema<T>(marker: string): ZodType<T> {
  return {
    safeParse: (_v: unknown): { success: false; error: { issues: ReadonlyArray<unknown> } } => ({
      success: false,
      error: { issues: [{ marker, message: "test-rejection" }] },
    }),
  } as unknown as ZodType<T>;
}
