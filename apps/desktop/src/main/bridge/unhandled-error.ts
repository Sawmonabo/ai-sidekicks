// The read of what a window sends `app.reportUnhandledError`: a page is untrusted, so its report is
// parsed here, where it enters main, and refused whole when it is not one. Its texts are taken at
// any length and cut to their bounds by the relay, so a long stack still reaches the log.

import { APP_ERROR_ROLES } from "@ai-sidekicks/contracts/daemon/app-error";
import { z } from "zod";

import type { UnhandledErrorReport } from "#shared/unhandled-error.js";

const roleSchema = z.enum(APP_ERROR_ROLES).exclude(["main"]);

const lineOrColumnSchema = z.number().int().nonnegative();

const reportSchema: z.ZodType<UnhandledErrorReport> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["uncaught-error", "unhandled-rejection"]),
      role: roleSchema,
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
    .object({ kind: z.literal("held-back"), role: roleSchema, count: z.number().int().positive() })
    .strict(),
]);

/** Parses a window's report; throws a `ZodError` for anything that is not one. */
export function parseUnhandledErrorReport(value: unknown): UnhandledErrorReport {
  return reportSchema.parse(value);
}
