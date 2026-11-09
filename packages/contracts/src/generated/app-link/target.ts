// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a `sidekicks://` link opens, and the link's URI scheme.

import type { SessionId } from "../session/id.js";
import type { WorkflowRunId } from "../workflow/run/id.js";

/**
 * The link's URI scheme, which the desktop registers with the operating system as the app's
 * own and finds a link by on a command line.
 */
export const APP_LINK_SCHEME = "sidekicks" as const;

/**
 * What a `sidekicks://` link opens: a session, or a workflow run's page.
 */
export type AppLinkTarget =
  | {
      kind: "session";
      /**
       * The session's id.
       */
      sessionId: SessionId;
    }
  | {
      kind: "workflowRun";
      /**
       * The run's id.
       */
      workflowRunId: WorkflowRunId;
    };
