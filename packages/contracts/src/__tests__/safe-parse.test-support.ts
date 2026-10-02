// One-line parse assertions the method-table tests share, kept as one body.
import { expect } from "vitest";

/** Anything with Zod's `safeParse`, such as a descriptor's request or response schema. */
interface SafeParsingSchema {
  safeParse(value: unknown): { success: boolean };
}

/** Asserts that `schema` accepts `value`. */
export function accepts(schema: SafeParsingSchema, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

/** Asserts that `schema` refuses `value`. */
export function refuses(schema: SafeParsingSchema, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}
