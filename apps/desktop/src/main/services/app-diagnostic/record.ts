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
  bounded,
  redactErrorParts,
  redactMessage,
  type RedactedErrorParts,
} from "#shared/app-diagnostic/redaction.js";
import type { DiagnosticRecord } from "#shared/app-diagnostic/report.js";

/** One error as main has it, before it is redacted. */
export interface AppErrorParts extends RedactedErrorParts {
  readonly kind: AppErrorThrown["kind"];
  readonly role: AppDiagnosticRole;
}

/** The record main writes of one error, stamped `at`. */
export function boundAppError(parts: AppErrorParts, at: Date): AppErrorThrown {
  return { kind: parts.kind, at: at.toISOString(), role: parts.role, ...redactErrorParts(parts) };
}

/** The record main writes of one captured line, stamped when the window captured it. */
export function boundCapturedDiagnostic(record: DiagnosticRecord): AppCapturedDiagnostic {
  return {
    kind: "captured",
    at: record.at,
    severity: record.severity,
    source: bounded(record.source, APP_DIAGNOSTIC_TEXT_BOUNDS.label),
    capturedKind: bounded(record.kind, APP_DIAGNOSTIC_TEXT_BOUNDS.label),
    detail: redactMessage(record.detail),
  };
}
