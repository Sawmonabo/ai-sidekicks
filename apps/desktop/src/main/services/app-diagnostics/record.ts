// The record main writes of an error nothing handled, whether a window reported it or main had it,
// or of a line a window's diagnostic capture took: its texts redacted and bounded as the service's
// log takes them, and stamped.

import {
  APP_DIAGNOSTIC_TEXT_BOUNDS,
  type AppCapturedDiagnostic,
  type AppDiagnosticRole,
  type AppErrorThrown,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";

import {
  redactErrorParts,
  redactMessage,
  type RedactedErrorParts,
} from "#shared/app-diagnostic/redaction.js";
import type { DiagnosticRecord } from "#shared/app-diagnostic/report.js";

/** One error as main has it, before it is redacted. */
export interface UnhandledErrorParts extends RedactedErrorParts {
  readonly kind: AppErrorThrown["kind"];
  readonly role: AppDiagnosticRole;
}

/** The record main writes of one error, stamped `at`. */
export function boundAppError(parts: UnhandledErrorParts, at: Date): AppErrorThrown {
  return { kind: parts.kind, at: at.toISOString(), role: parts.role, ...redactErrorParts(parts) };
}

/** The record main writes of one captured line, stamped when the window captured it. */
export function boundCapturedDiagnostic(record: DiagnosticRecord): AppCapturedDiagnostic {
  return {
    kind: "captured",
    at: record.at,
    severity: record.severity,
    source: record.source.slice(0, APP_DIAGNOSTIC_TEXT_BOUNDS.label),
    capturedKind: record.kind.slice(0, APP_DIAGNOSTIC_TEXT_BOUNDS.label),
    detail: redactMessage(record.detail),
  };
}

/** What two records of one error or one line share, so a repeat is told from a different one. */
export function fingerprintOf(record: AppErrorThrown | AppCapturedDiagnostic): string {
  if (record.kind === "captured") {
    return JSON.stringify([record.kind, record.source, record.capturedKind, record.detail]);
  }
  const firstFrame = record.stack?.split("\n", 1)[0] ?? "";
  return JSON.stringify([record.kind, record.role, record.name, record.message, firstFrame]);
}
