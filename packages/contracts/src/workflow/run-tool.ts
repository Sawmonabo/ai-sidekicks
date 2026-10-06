// The `workflow_run` tool an agent calls from a session. The daemon registers it in each
// session's callback tool registry and the desktop lists it on an agent definition's tool
// allowlist, so both read this one definition.
import { z } from "zod";

import type { SessionCallbackTool } from "../provider/driver/driver.js";

/** The `workflow_run` input: a workflow named by its name, which the library holds once. */
export interface WorkflowRunToolInput {
  definitionName: string;
}
/** Schema for {@link WorkflowRunToolInput}. */
export const WorkflowRunToolInputSchema: z.ZodType<WorkflowRunToolInput, WorkflowRunToolInput> = z
  .object({ definitionName: z.string().min(1).describe("The workflow's name.") })
  .strict();

/** The `workflow_run` tool: starts a named workflow's latest version in the calling session. */
export const WORKFLOW_RUN_TOOL: SessionCallbackTool = {
  name: "workflow_run",
  description:
    "Start a workflow run in this session by the workflow's name. The run works in this " +
    "session's folder.",
  inputSchema: z.toJSONSchema(WorkflowRunToolInputSchema),
};
