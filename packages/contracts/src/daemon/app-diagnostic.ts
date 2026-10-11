// What the desktop app records about itself, which its main process hands the service to write in
// its diagnostic log, so it is kept, and dropped, with the service's own lines: an error nothing
// handled, a line a window's diagnostic capture took, the window process going away, and a count
// of what was not written. Each text is bounded here; main fills a record with an error's name,
// its message with every quoted run taken out, and its stack frames, and never with a value a
// promise was rejected with.
import { z } from "zod";

import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import {
  defineMethodDescriptors,
  type EmptyPayload,
  EmptyPayloadSchema,
  type MethodDescriptor,
} from "../method-descriptor.js";

/** The longest each text of an app diagnostic record may be, in UTF-16 code units. */
export const APP_DIAGNOSTIC_TEXT_BOUNDS = {
  /** An error's name, such as `TypeError`. */
  name: 128,
  /** An error's message, or what a captured line says happened. */
  message: 1024,
  /** Its stack frames, one per line; about sixty frames of the app's own bundle. */
  stack: 8192,
  /** The address of the script it was thrown in, without its query or fragment. */
  address: 2048,
  /** Why the window's process went, in Electron's own word. */
  reason: 64,
  /** The module that captured a line, or what kind of line it is. */
  label: 128,
} as const;

/**
 * Where in the app an error went unhandled: main, the hidden console document, a window of session
 * views, or a pane's own window.
 */
export const APP_DIAGNOSTIC_ROLES = [
  "main",
  "console-document",
  "console-window",
  "pane-window",
] as const;

/** One place from {@link APP_DIAGNOSTIC_ROLES}. */
export type AppDiagnosticRole = (typeof APP_DIAGNOSTIC_ROLES)[number];

/** How bad a captured line is. */
export const APP_DIAGNOSTIC_SEVERITIES = ["error", "warning", "notice"] as const;

/** One severity from {@link APP_DIAGNOSTIC_SEVERITIES}. */
export type AppDiagnosticSeverity = (typeof APP_DIAGNOSTIC_SEVERITIES)[number];

/** Where a script error was thrown: the script's address, and the line and column from 1. */
export interface AppErrorSource {
  address: string;
  line: number;
  column: number;
}

/** An exception nothing caught, or a promise rejected with nothing to handle it. */
export interface AppErrorThrown {
  kind: "uncaught-error" | "unhandled-rejection";
  /** When it happened. */
  at: string;
  role: AppDiagnosticRole;
  /** The error's name, or `null` for a thrown value that is no error. */
  name: string | null;
  message: string;
  stack: string | null;
  source: AppErrorSource | null;
}

/** A line a window's diagnostic capture took: something the app could not do or could not read. */
export interface AppCapturedDiagnostic {
  kind: "captured";
  /** When the window captured it. */
  at: string;
  severity: AppDiagnosticSeverity;
  /** The module that captured it. */
  source: string;
  /** What kind of line it is, in that module's own words. */
  capturedKind: string;
  /** What happened, with every quoted run taken out. */
  detail: string;
}

/** The process drawing every window went away; main reloads it. */
export interface AppRendererGone {
  kind: "renderer-gone";
  at: string;
  reason: string;
  exitCode: number;
}

/** Why records were not written. */
export type AppDiagnosticHeldBackCause =
  /** A window had more to send than it holds while it waited to send. */
  | "window-buffer-full"
  /** Past the rate at which the app writes records. */
  | "repeated"
  /** The service could not be reached and the app holds no more. */
  | "service-unreachable";

/** How many records were not written, and why. */
export interface AppDiagnosticsHeldBack {
  kind: "held-back";
  at: string;
  count: number;
  cause: AppDiagnosticHeldBackCause;
}

/** One record of `daemon.appDiagnostic.record`. */
export type AppDiagnosticRecord =
  | AppErrorThrown
  | AppCapturedDiagnostic
  | AppRendererGone
  | AppDiagnosticsHeldBack;

const textSchema = (bound: number): z.ZodString => z.string().max(bound);

const lineOrColumnSchema = z.number().int().nonnegative();

const AppErrorThrownSchema = z
  .object({
    kind: z.enum(["uncaught-error", "unhandled-rejection"]),
    at: isoDateTimeSchema,
    role: z.enum(APP_DIAGNOSTIC_ROLES),
    name: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.name).nullable(),
    message: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.message),
    stack: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.stack).nullable(),
    source: z
      .object({
        address: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.address),
        line: lineOrColumnSchema,
        column: lineOrColumnSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Parses an {@link AppDiagnosticRecord}. */
export const AppDiagnosticRecordSchema: z.ZodType<AppDiagnosticRecord, AppDiagnosticRecord> =
  z.union([
    AppErrorThrownSchema,
    z
      .object({
        kind: z.literal("captured"),
        at: isoDateTimeSchema,
        severity: z.enum(APP_DIAGNOSTIC_SEVERITIES),
        source: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.label),
        capturedKind: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.label),
        detail: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.message),
      })
      .strict(),
    z
      .object({
        kind: z.literal("renderer-gone"),
        at: isoDateTimeSchema,
        reason: textSchema(APP_DIAGNOSTIC_TEXT_BOUNDS.reason),
        exitCode: z.number().int(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("held-back"),
        at: isoDateTimeSchema,
        count: countSchema,
        cause: z.enum(["window-buffer-full", "repeated", "service-unreachable"]),
      })
      .strict(),
  ]);

/** The method main writes an app diagnostic with. */
export interface DaemonAppDiagnosticMethodDescriptors {
  /** Writes one record to the service's diagnostic log; answers once it is written. */
  readonly "daemon.appDiagnostic.record": MethodDescriptor<
    "daemon.appDiagnostic.record",
    AppDiagnosticRecord,
    EmptyPayload
  >;
}

/** The app diagnostic method's name, procedure type and shapes. */
export const DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS: DaemonAppDiagnosticMethodDescriptors =
  defineMethodDescriptors({
    "daemon.appDiagnostic.record": {
      method: "daemon.appDiagnostic.record",
      procedureType: "mutation",
      // Writes the log and no state, so neither a recovery nor a version apart refuses it.
      mutating: false,
      requestSchema: AppDiagnosticRecordSchema,
      responseSchema: EmptyPayloadSchema,
    },
  });
