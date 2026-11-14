// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The result of a provider's compaction, composed by the daemon from the wait's own end.

/**
 * The result of a compaction attempt: `applied` only after the provider's compaction frame was
 * seen, `refused` when nothing was sent, `failed` when something was sent and no boundary came.
 */
export type AgentRunContextCompactResponse =
  | {
      status: "applied";
      /**
       * Where the boundary sits; `null` where the provider's frame carried none.
       */
      boundaryPosition: number | null;
    }
  | {
      status: "refused";
      /**
       * Why.
       */
      reason: "commandAbsent";
    }
  | {
      status: "failed";
      /**
       * Why.
       */
      reason: "bindingLost" | "providerError" | "notCompacted";
    };

export { validateAgentRunContextCompactResponse } from "../../checks/provider/driver/compaction.js";
