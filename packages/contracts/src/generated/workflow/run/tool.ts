// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `workflow_run` tool an agent calls from a session: the one definition the desktop lists on an agent definition's tool allowlist and the daemon's callback tool registry serves.

/** The `workflow_run` tool: starts a named workflow's latest version in the calling session. */
export const WORKFLOW_RUN_TOOL = {
  name: "workflow_run",
  description:
    "Start a workflow run in this session by the workflow's name. The run works in this session's folder, or in the repository of the project it names.",
  inputSchema: {
    type: "object",
    properties: {
      definition_name: {
        description: "The workflow's name: at least one character.",
        type: "string",
        minLength: 1,
      },
      project: {
        description:
          "The project whose repository the run works in, named from session_options, for a workflow with a step that needs a repository; named only from a chat, since a project session's run works in its own repository. Leave it out to run in this session's folder. 1 to 256 characters, not only whitespace, with no NUL character.",
        type: "string",
        minLength: 1,
        pattern:
          "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$",
        maxLength: 256,
      },
    },
    additionalProperties: false,
    required: ["definition_name"],
  },
} as const;

/**
 * The `workflow_run` input: a workflow named by its name, which the library holds once, and the
 * project whose repository the run works in, named as `session_options` lists it; the daemon
 * resolves the name to the project. Its members are `snake_case`, as the model reads and writes
 * them.
 */
export interface WorkflowRunToolInput {
  /**
   * The workflow's name: at least one character.
   */
  definition_name: string;
  /**
   * The project whose repository the run works in, named from session_options, for a workflow with a step that needs a repository; named only from a chat, since a project session's run works in its own repository. Leave it out to run in this session's folder. 1 to 256 characters, not only whitespace, with no NUL character.
   */
  project?: string;
}
