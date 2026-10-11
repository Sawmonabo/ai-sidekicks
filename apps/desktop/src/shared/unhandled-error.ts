// An error nothing handled, as a window reports it to main and as main reads its own. An error is
// read alike whichever window's realm made it, so `instanceof Error` is never the test; a thrown
// value that is no error is told only by its type, never by the value, which can be anything the
// person wrote.

import type { AppErrorRole, AppErrorSource } from "@ai-sidekicks/contracts/daemon/app-error";

/** Which window an error went unhandled in. */
export type WindowErrorRole = Exclude<AppErrorRole, "main">;

/** What a window tells main of an error nothing in it handled. */
export type UnhandledErrorReport =
  | {
      readonly kind: "uncaught-error" | "unhandled-rejection";
      readonly role: WindowErrorRole;
      readonly name: string | null;
      readonly message: string;
      readonly stack: string | null;
      readonly source: AppErrorSource | null;
    }
  /** Errors the window had before it could send them, past what it holds. */
  | { readonly kind: "held-back"; readonly role: WindowErrorRole; readonly count: number };

/** An error's name, message and stack, or for a value that is no error, its type alone. */
export interface ThrownValueParts {
  readonly name: string | null;
  readonly message: string;
  readonly stack: string | null;
}

/** Reads a thrown or rejected value: an error's own parts, or a sentence naming the value's type. */
export function readThrownValue(
  value: unknown,
  kind: "uncaught-error" | "unhandled-rejection",
): ThrownValueParts {
  if (isErrorLike(value)) {
    return {
      name: value.name,
      message: value.message,
      stack: typeof value.stack === "string" ? value.stack : null,
    };
  }
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return {
    name: null,
    message:
      kind === "uncaught-error"
        ? `The thrown value is not an error; its type is ${type}.`
        : `The rejection's value is not an error; its type is ${type}.`,
    stack: null,
  };
}

function isErrorLike(
  value: unknown,
): value is { readonly name: string; readonly message: string; readonly stack?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}
