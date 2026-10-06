// The `workflow_run` tool an agent calls from a session. The daemon registers it in each
// session's callback tool registry and the desktop lists it on an agent definition's tool
// allowlist, so both read this one definition.
import { z } from "zod";

import { PROJECT_NAME_MAX_LEN } from "../project.js";
import type { SessionCallbackTool } from "../provider/driver/tools.js";
import { wireFreeFormString } from "../free-form-string.js";

/**
 * The `workflow_run` input: a workflow named by its name, which the library holds once, and the
 * project whose repository the run works in, for a workflow that needs one, named as
 * `session_options` lists it; the daemon resolves the name to the project.
 */
export interface WorkflowRunToolInput {
  definitionName: string;
  project?: string | undefined;
}
/** Schema for {@link WorkflowRunToolInput}. */
export const WorkflowRunToolInputSchema: z.ZodType<WorkflowRunToolInput, WorkflowRunToolInput> = z
  .object({
    definitionName: z.string().min(1).describe("The workflow's name."),
    project: wireFreeFormString(PROJECT_NAME_MAX_LEN, "WorkflowRunToolInput.project")
      .optional()
      .describe(
        "The project whose repository the run works in, named from session_options, for a " +
          "workflow with a step that needs a repository; named only from a chat, since a " +
          "project session's run works in its own repository. Leave it out to run in this " +
          "session's folder.",
      ),
  })
  .strict();

/** The `workflow_run` tool: starts a named workflow's latest version in the calling session. */
export const WORKFLOW_RUN_TOOL: SessionCallbackTool = {
  name: "workflow_run",
  description:
    "Start a workflow run in this session by the workflow's name. The run works in this " +
    "session's folder, or in the repository of the project it names.",
  inputSchema: z.toJSONSchema(WorkflowRunToolInputSchema),
};
