// The id of one run, which every run, session, approval, question, plan and workflow contract
// carries.
import { z } from "zod";

import { brandedUuidIdSchema } from "../internal/branded.js";

/** Branded run identifier: a plain UUID string at runtime. */
export type RunId = string & { readonly __brand: "RunId" };

/**
 * Validates a caller-supplied run id; the only place a string becomes a `RunId`. A non-UUID is
 * refused, so a path or SQL fragment never reaches a store lookup.
 */
export const RunIdSchema: z.ZodType<RunId, RunId> = brandedUuidIdSchema<RunId>("RunId");
