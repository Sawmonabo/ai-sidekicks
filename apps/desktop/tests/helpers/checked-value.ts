// A value a test builds in a contract's shape, held to the contract by its generated check.

import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";

/**
 * `value` as the `T` `check` admits. Throws, naming the check's first fault, when the check
 * refuses it, so a fixture that drifts from the contract fails where it is built.
 */
export function checkedValue<T>(check: SchemaCheck<T>, value: unknown): T {
  if (check(value)) {
    return value;
  }
  throw new Error(`the contract refuses the value: ${JSON.stringify(check.errors?.[0])}`);
}
