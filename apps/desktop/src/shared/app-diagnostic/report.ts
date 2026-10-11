// What a window hands main for the background service's diagnostic log, and how an error nothing
// handled is read, as a window reports it and as main reads its own. An error is read alike
// whichever window's realm made it, so `instanceof Error` is never the test; a thrown value that
// is no error is told only by its type, never by the value, which can be anything the person
// wrote.

import type {
  AppDiagnosticHeldBackCause,
  AppDiagnosticRecord,
  AppDiagnosticRole,
  AppDiagnosticSeverity,
  AppErrorSource,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";

import { APP_DIAGNOSTIC_RATE_BOUNDS } from "./rate-limit.js";

/** Which window's realm raised an error nothing handled. */
export type WindowDiagnosticRole = Exclude<AppDiagnosticRole, "main">;

/** Why a window held reports back: past what it holds, or past the rate it sends at. */
export type WindowHeldBackCause = Extract<
  AppDiagnosticHeldBackCause,
  "window-buffer-full" | "past-rate"
>;

/** Every {@link WindowHeldBackCause}, for the parse where a window's reports enter main. */
export const WINDOW_HELD_BACK_CAUSES: readonly WindowHeldBackCause[] = [
  "window-buffer-full",
  "past-rate",
];

/** One line a window's diagnostic capture takes. */
export interface DiagnosticRecord {
  /** When it happened, ISO-8601, from the caller's clock rather than a clock here. */
  readonly at: string;
  readonly severity: AppDiagnosticSeverity;
  /** The subsystem that captured it — a module path or a registry name. */
  readonly source: string;
  /** What class of thing it is, in the capturing subsystem's own vocabulary. */
  readonly kind: string;
  /** What happened, in the imperative a reader needs to act on. */
  readonly detail: string;
}

/** One thing a window hands main. */
export type WindowDiagnosticReport =
  | {
      readonly kind: "uncaught-error" | "unhandled-rejection";
      readonly role: WindowDiagnosticRole;
      readonly name: string | null;
      readonly message: string;
      readonly stack: string | null;
      readonly source: AppErrorSource | null;
    }
  | { readonly kind: "captured"; readonly record: DiagnosticRecord }
  /** Reports the window did not send, and why. */
  | { readonly kind: "held-back"; readonly cause: WindowHeldBackCause; readonly count: number };

/**
 * The most reports one send carries: as many as the rate lets go in a minute, so what a window
 * sends at the end of a turn is one batch, and no batch is a large message built when memory is
 * short.
 */
export const WINDOW_DIAGNOSTIC_BATCH_BOUND: number = APP_DIAGNOSTIC_RATE_BOUNDS.all;

/** How many records one stands for: a count of records held back, all of them, else one. */
export function recordCountOf(record: AppDiagnosticRecord | WindowDiagnosticReport): number {
  return record.kind === "held-back" ? record.count : 1;
}

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
