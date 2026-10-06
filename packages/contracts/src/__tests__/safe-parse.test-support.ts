// One-line parse assertions the contract suites share, kept as one body.
import { expect } from "vitest";

/** Anything with Zod's `safeParse`, such as a descriptor's request or response schema. */
interface SafeParsingSchema {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues: readonly { path: readonly PropertyKey[] }[] } | undefined;
  };
}

/** Asserts that `schema` accepts `value`. */
export function accepts(schema: SafeParsingSchema, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

/** Asserts that `schema` refuses `value`. */
export function refuses(schema: SafeParsingSchema, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

/** Asserts that `schema` refuses `value` with an issue at `path`, its keys joined by dots. */
export function refusesAt(schema: SafeParsingSchema, value: unknown, path: string): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(path);
}
