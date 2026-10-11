// The read of what a window sends `app.reportWindowDiagnostics`: a page is untrusted, so its batch
// is parsed here, where it enters main, and refused whole when it is not one. Its texts are taken
// at any length and cut to their bounds by the relay, so a long stack still reaches the log.

import {
  APP_DIAGNOSTIC_ROLES,
  APP_DIAGNOSTIC_SEVERITIES,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import { z } from "zod";

import {
  WINDOW_DIAGNOSTIC_BATCH_BOUND,
  WINDOW_HELD_BACK_CAUSES,
  type WindowDiagnosticReport,
} from "#shared/app-diagnostic/report.js";

const lineOrColumnSchema = z.number().int().nonnegative();

const reportSchema: z.ZodType<WindowDiagnosticReport> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["uncaught-error", "unhandled-rejection"]),
      role: z.enum(APP_DIAGNOSTIC_ROLES).exclude(["main"]),
      name: z.string().nullable(),
      message: z.string(),
      stack: z.string().nullable(),
      source: z
        .object({ address: z.string(), line: lineOrColumnSchema, column: lineOrColumnSchema })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("captured"),
      record: z
        .object({
          at: z.iso.datetime({ offset: true }),
          severity: z.enum(APP_DIAGNOSTIC_SEVERITIES),
          source: z.string(),
          kind: z.string(),
          detail: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("held-back"),
      cause: z.enum(WINDOW_HELD_BACK_CAUSES),
      count: z.number().int().positive(),
    })
    .strict(),
]);

const batchSchema = z.array(reportSchema).min(1).max(WINDOW_DIAGNOSTIC_BATCH_BOUND);

/** Parses a window's batch of reports; throws a `ZodError` for anything that is not one. */
export function parseWindowDiagnosticReports(value: unknown): readonly WindowDiagnosticReport[] {
  return batchSchema.parse(value);
}
