// A Claude Code turn that settled on its terminal frame: the output speed it ran at is settled, a
// compaction still waiting on it ends uncompacted, the session's turn is released, helper starts
// the turn held are let go, and a build move that waited for the turn goes.

import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import type { ClaudeHandshakeRegister } from "../handshake-register.js";
import type { ClaudeHookCallbacks } from "../hooks/callbacks.js";
import type { ClaudeHelperLimit } from "../hooks/helper-limit.js";
import type { LiveClaudeSession } from "../session/state.js";
import type { ClaudeRunRoutes } from "./routes.js";

/** What a turn's settlement releases. */
export interface ClaudeTurnSettlementDependencies {
  readonly handshakes: ClaudeHandshakeRegister;
  readonly runRoutes: ClaudeRunRoutes;
  readonly helpers: ClaudeHelperLimit;
  readonly hookCallbacks: ClaudeHookCallbacks;
  /** The compaction waits, which the end of a compaction's own turn settles. */
  readonly pendingCompactions: PendingCompactionRegistry;
  /** A build move that waited for the session's running reply goes now. */
  readonly moveAfterTurn: (live: LiveClaudeSession) => void;
}

/** Settles each turn of a live session when its terminal frame arrives. */
export class ClaudeTurnSettlement {
  readonly #dependencies: ClaudeTurnSettlementDependencies;

  constructor(dependencies: ClaudeTurnSettlementDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Settles the session's turn. Claude Code takes one turn at a time per session, so whatever held
   * the turn is what just ended; the stream delivered its end first. Only routes retire, never the
   * slot.
   */
  settleTurn(live: LiveClaudeSession): void {
    const { handshakes, runRoutes, helpers, hookCallbacks, pendingCompactions, moveAfterTurn } =
      this.#dependencies;
    // A turn that ended before its handshake reported settles on the state the process holds.
    handshakes.settleRunOutputSpeed(live.sessionId, live.providerSessionId);
    // A compaction holds the turn while it waits, so a turn ending under a wait is the compaction's
    // own, whose frame came first if it compacted.
    pendingCompactions.observeTurnEnd(live.sessionId);
    runRoutes.retireRunRoutes(live.sessionId);
    hookCallbacks.admitHelperStarts(live, helpers.turnEnded(live.sessionId));
    moveAfterTurn(live);
  }
}
