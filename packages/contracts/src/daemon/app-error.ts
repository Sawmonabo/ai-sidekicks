// An error nothing handled in the desktop app, which the app's main process hands the service to
// write in its diagnostic log, so it is kept, and dropped, with the service's own lines. Each text
// is bounded here; main fills the record with an error's name, its message with every quoted run
// taken out, and its stack frames, and never with a value a promise was rejected with.
import { z } from "zod";

import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import {
  defineMethodDescriptors,
  type EmptyPayload,
  EmptyPayloadSchema,
  type MethodDescriptor,
} from "../method-descriptor.js";

/** The longest each text of an app error record may be, in UTF-16 code units. */
export const APP_ERROR_TEXT_BOUNDS = {
  /** An error's name, such as `TypeError`. */
  name: 128,
  /** Its message. */
  message: 1024,
  /** Its stack frames, one per line; about sixty frames of the app's own bundle. */
  stack: 8192,
  /** The address of the script it was thrown in, without its query or fragment. */
  address: 2048,
  /** Why the window's process went, in Electron's own word. */
  reason: 64,
} as const;

/**
 * Where in the app an error went unhandled: main, the hidden console document, a window of session
 * views, or a pane's own window.
 */
export const APP_ERROR_ROLES = [
  "main",
  "console-document",
  "console-window",
  "pane-window",
] as const;

/** One place from {@link APP_ERROR_ROLES}. */
export type AppErrorRole = (typeof APP_ERROR_ROLES)[number];

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
  role: AppErrorRole;
  /** The error's name, or `null` for a thrown value that is no error. */
  name: string | null;
  message: string;
  stack: string | null;
  source: AppErrorSource | null;
}

/** The process drawing every window went away; main reloads it. */
export interface AppRendererGone {
  kind: "renderer-gone";
  at: string;
  reason: string;
  exitCode: number;
}

/** Why records were not written. */
export type AppErrorHeldBackCause =
  /** A window had more errors before it could send them than it holds. */
  | "window-not-ready"
  /** Past the rate at which the app writes errors. */
  | "repeated"
  /** The service could not be reached and the app holds no more. */
  | "service-unreachable";

/** How many records were not written, and why. */
export interface AppErrorsHeldBack {
  kind: "held-back";
  at: string;
  count: number;
  cause: AppErrorHeldBackCause;
}

/** One record of `daemon.appError.record`. */
export type AppErrorRecord = AppErrorThrown | AppRendererGone | AppErrorsHeldBack;

const textSchema = (bound: number): z.ZodString => z.string().max(bound);

const lineOrColumnSchema = z.number().int().nonnegative();

const AppErrorThrownSchema = z
  .object({
    kind: z.enum(["uncaught-error", "unhandled-rejection"]),
    at: isoDateTimeSchema,
    role: z.enum(APP_ERROR_ROLES),
    name: textSchema(APP_ERROR_TEXT_BOUNDS.name).nullable(),
    message: textSchema(APP_ERROR_TEXT_BOUNDS.message),
    stack: textSchema(APP_ERROR_TEXT_BOUNDS.stack).nullable(),
    source: z
      .object({
        address: textSchema(APP_ERROR_TEXT_BOUNDS.address),
        line: lineOrColumnSchema,
        column: lineOrColumnSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Parses an {@link AppErrorRecord}. */
export const AppErrorRecordSchema: z.ZodType<AppErrorRecord, AppErrorRecord> = z.union([
  AppErrorThrownSchema,
  z
    .object({
      kind: z.literal("renderer-gone"),
      at: isoDateTimeSchema,
      reason: textSchema(APP_ERROR_TEXT_BOUNDS.reason),
      exitCode: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("held-back"),
      at: isoDateTimeSchema,
      count: countSchema,
      cause: z.enum(["window-not-ready", "repeated", "service-unreachable"]),
    })
    .strict(),
]);

/** The method main writes an app error with. */
export interface DaemonAppErrorMethodDescriptors {
  /** Writes one record to the service's diagnostic log; answers once it is written. */
  readonly "daemon.appError.record": MethodDescriptor<
    "daemon.appError.record",
    AppErrorRecord,
    EmptyPayload
  >;
}

/** The app error method's name, procedure type and shapes. */
export const DAEMON_APP_ERROR_METHOD_DESCRIPTORS: DaemonAppErrorMethodDescriptors =
  defineMethodDescriptors({
    "daemon.appError.record": {
      method: "daemon.appError.record",
      procedureType: "mutation",
      // Writes the log and no state, so neither a recovery nor a version apart refuses it.
      mutating: false,
      requestSchema: AppErrorRecordSchema,
      responseSchema: EmptyPayloadSchema,
    },
  });
