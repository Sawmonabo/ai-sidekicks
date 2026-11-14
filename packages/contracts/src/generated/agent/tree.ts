// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session's agent tree: how the daemon's index names each agent in a session.

import type { RunId } from "../run/id.js";
import type { AgentId } from "./definition.js";

/**
 * The daemon-minted handle of a provider's own helper inside its parent's run: opaque, and
 * resolved only by the daemon's parent-to-child index that minted it.
 */
export type ChildHandle = string & { readonly __brand: "ChildHandle" };
/**
 * One agent in the session's tree as the daemon's index names it: an agent with an id (the lead,
 * or one a bridge `run` started), or a provider's own helper by the run it runs in and its
 * handle.
 */
export type AgentTreeMember =
  | {
      kind: "agent";
      /**
       * The agent.
       */
      agentId: AgentId;
    }
  | {
      kind: "providerChild";
      /**
       * The run it runs in.
       */
      runId: RunId;
      /**
       * Its handle.
       */
      childHandle: ChildHandle;
    };

export { validateAgentTreeMember, validateChildHandle } from "../checks/agent/tree.js";
