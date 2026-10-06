// The id of one workflow run, which every run method, event and step record carries.
import { z } from "zod";

import { brandedUuidIdSchema } from "../../internal/branded.js";

/** A workflow run's id: a UUID the daemon mints; a client never builds one. */
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
/** Wire schema for {@link WorkflowRunId}. */
export const WorkflowRunIdSchema: z.ZodType<WorkflowRunId, WorkflowRunId> =
  brandedUuidIdSchema<WorkflowRunId>("WorkflowRunId");
