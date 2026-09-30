/**
 * Small readers that pull a typed field out of an unknown JSON value, throwing a configuration
 * error when a required field is missing or the wrong type.
 */

import { CodexDriverConfigError } from "./session-errors.js";

/** The one meaning of "an object" on a parse path; arrays are excluded. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws a configuration error naming the label. */
export function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new CodexDriverConfigError(`${label} must be an object.`, label);
  }
  return value;
}

/** Reads a non-empty string field, or throws a configuration error naming the label. */
export function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string.`, label);
  }
  return value;
}

/**
 * Reads a non-empty string field, or undefined when it is absent; throws when present but empty or
 * not a string.
 */
export function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string when present.`, label);
  }
  return value;
}
