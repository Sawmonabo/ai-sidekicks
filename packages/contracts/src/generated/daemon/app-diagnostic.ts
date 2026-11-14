// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the desktop app records about itself, which its main process hands the service to write in its diagnostic log.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { EmptyPayload } from "../method-descriptor.js";

/** The longest each text of an app diagnostic record may be. */
export const APP_DIAGNOSTIC_TEXT_BOUNDS = {
  name: 128,
  message: 1024,
  stack: 8192,
  address: 2048,
  reason: 64,
  label: 128,
} as const;

/** Every place an error can go unhandled, in order. */
export const APP_DIAGNOSTIC_ROLES = [
  "main",
  "consoleDocument",
  "consoleWindow",
  "paneWindow",
] as const;

/** Every severity of a captured line, worst first. */
export const APP_DIAGNOSTIC_SEVERITIES = ["error", "warning", "notice"] as const;

/**
 * Where in the app an error went unhandled: main; the hidden console document, which runs the
 * code of every window, so its errors read here; or a window of session views or a pane's own
 * window, for what that window's own objects raise.
 */
export type AppDiagnosticRole = "main" | "consoleDocument" | "consoleWindow" | "paneWindow";
/**
 * How bad a captured line is.
 */
export type AppDiagnosticSeverity = "error" | "warning" | "notice";
/**
 * Why records were not written.
 */
export type AppDiagnosticHeldBackCause =
  | "windowBufferFull"
  | "pastRate"
  | "serviceUnreachable"
  | "serviceRefused";
/**
 * One record of `daemon.appDiagnostic.record`, told apart by its `kind`.
 */
export type AppDiagnosticRecord =
  | {
      kind: "uncaughtError";
      /**
       * When it happened.
       */
      at: WireInstant;
      /**
       * Where in the app it went unhandled.
       */
      role: AppDiagnosticRole;
      /**
       * The error's name, or `null` for a thrown value that is no error.
       */
      name: string | null;
      /**
       * Its message, with every quoted run taken out.
       */
      message: string;
      /**
       * Its stack frames, one per line, or `null` where it has none.
       */
      stack: string | null;
      /**
       * Where it was thrown, or `null` where that is not known.
       */
      source: AppErrorSource | null;
    }
  | {
      kind: "unhandledRejection";
      /**
       * When it happened.
       */
      at: WireInstant;
      /**
       * Where in the app it went unhandled.
       */
      role: AppDiagnosticRole;
      /**
       * The error's name, or `null` for a thrown value that is no error.
       */
      name: string | null;
      /**
       * Its message, with every quoted run taken out.
       */
      message: string;
      /**
       * Its stack frames, one per line, or `null` where it has none.
       */
      stack: string | null;
      /**
       * Where it was thrown, or `null` where that is not known.
       */
      source: AppErrorSource | null;
    }
  | {
      kind: "captured";
      /**
       * When the window captured it.
       */
      at: WireInstant;
      /**
       * How bad it is.
       */
      severity: AppDiagnosticSeverity;
      /**
       * The module that captured it.
       */
      source: string;
      /**
       * What kind of line it is, in that module's own words.
       */
      capturedKind: string;
      /**
       * What happened, with every quoted run taken out.
       */
      detail: string;
    }
  | {
      kind: "rendererGone";
      /**
       * When it went.
       */
      at: WireInstant;
      /**
       * Why it went, in Electron's own word.
       */
      reason: string;
      /**
       * Its exit code.
       */
      exitCode: number;
    }
  | {
      kind: "heldBack";
      /**
       * When it was counted.
       */
      at: WireInstant;
      /**
       * How many records were not written.
       */
      count: number;
      /**
       * Why.
       */
      cause: AppDiagnosticHeldBackCause;
    };

/**
 * Where a script error was thrown: the script's address, and the line and column it names.
 */
export interface AppErrorSource {
  /**
   * The script's address, without its query or fragment.
   */
  address: string;
  /**
   * The line.
   */
  line: number;
  /**
   * The column.
   */
  column: number;
}

/** The methods of {@link DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS}, each with its kind. */
export interface DaemonAppDiagnosticMethodDescriptors {
  readonly "daemon.appDiagnostic.record": {
    readonly method: "daemon.appDiagnostic.record";
    readonly procedureType: "mutation";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS}. */
export interface DaemonAppDiagnosticMethodTypes {
  readonly "daemon.appDiagnostic.record": {
    readonly params: AppDiagnosticRecord;
    readonly result: EmptyPayload;
  };
}
/** The method main writes an app diagnostic with. */
export const DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS: DaemonAppDiagnosticMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.appDiagnostic.record": /* @__PURE__ */ Object.freeze({
      method: "daemon.appDiagnostic.record",
      procedureType: "mutation",
      mutating: false,
    }),
  });
