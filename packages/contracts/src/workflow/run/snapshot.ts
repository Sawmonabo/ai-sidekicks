// The two numbers that name one of a workflow run's snapshots: which execution of the run it
// belongs to, and which of that execution's approval pauses took it.
import { z } from "zod";

import { countSchema } from "../../internal/wire-scalars.js";

/** Which execution of a run a snapshot belongs to: 0 for the first, one more at each re-run. */
export const WorkflowRunEpochSchema: z.ZodNumber = countSchema;

/** Which approval pause of one execution took a snapshot, counted from 1. */
export const WorkflowRunPauseNumberSchema: z.ZodNumber = z.number().int().positive();
