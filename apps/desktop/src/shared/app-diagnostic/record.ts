// The service's diagnostic records by kind, each one arm of the generated record union.

import type { AppDiagnosticRecord } from "@ai-sidekicks/contracts/daemon/app-diagnostic";

/** The service's record of an error nothing handled, an uncaught one or a rejection. */
export type AppErrorThrown = Extract<
  AppDiagnosticRecord,
  { readonly kind: "uncaughtError" | "unhandledRejection" }
>;

/** The service's record of a line a window's diagnostic capture took. */
export type AppCapturedDiagnostic = Extract<AppDiagnosticRecord, { readonly kind: "captured" }>;

/** The service's record of how many records were held back, and why. */
export type AppDiagnosticHeldBack = Extract<AppDiagnosticRecord, { readonly kind: "heldBack" }>;
