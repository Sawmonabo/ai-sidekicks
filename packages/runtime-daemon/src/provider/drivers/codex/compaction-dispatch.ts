// Dispatching `thread/compact/start` on a Codex session and waiting for the `thread/compacted`
// frame that proves it ran.

import type { DriverCompactionResult, SessionId } from "@ai-sidekicks/contracts";
import type { PendingCompactionRegistry } from "../../compaction-wait.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import {
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexSessionRecord,
} from "./session-state.js";
import { normalizeProviderFailureDetail } from "./session-errors.js";
import {
  CODEX_COMPACTION_WAIT_MS,
  CODEX_THREAD_COMPACT_START_METHOD,
} from "./provider-commands.js";

/**
 * Sends the native compaction request and answers `applied` only on the typed compaction frame,
 * recording every other terminal as a diagnostic.
 */
export class CodexCompactionDispatch {
  readonly #options: Pick<CodexLifecycleOptions, "diagnostics">;
  readonly #pendingCompactions: PendingCompactionRegistry;

  constructor(
    options: Pick<CodexLifecycleOptions, "diagnostics">,
    pendingCompactions: PendingCompactionRegistry,
  ) {
    this.#options = options;
    this.#pendingCompactions = pendingCompactions;
  }

  /** Arms the wait before the request, so an early frame is seen, and settles on its terminal. */
  async dispatchCompaction(
    sessionId: SessionId,
    record: CodexSessionRecord,
  ): Promise<DriverCompactionResult> {
    const wait = this.#pendingCompactions.arm(
      codexCompactionWaitKey(sessionId, record.threadId),
      CODEX_COMPACTION_WAIT_MS,
    );
    try {
      await record.connection.request(CODEX_THREAD_COMPACT_START_METHOD, {
        threadId: record.threadId,
      });
    } catch (cause) {
      wait.abandon();
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "compaction_wait_terminal",
        rawWireType: CODEX_THREAD_COMPACT_START_METHOD,
        dispositionReason: normalizeProviderFailureDetail(cause),
        details: { sessionId, terminal: "provider_error" },
      });
      return { status: "failed", reason: "provider_error" };
    }
    const settlement = await wait.settled;
    if (settlement.terminal === "observed") {
      return { status: "applied", boundaryPosition: settlement.boundaryPosition };
    }
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "compaction_wait_terminal",
      rawWireType: CODEX_THREAD_COMPACT_START_METHOD,
      dispositionReason:
        settlement.terminal === "wait_expired"
          ? "the declared compaction bound elapsed with no typed compaction frame; a later frame still normalizes into its boundary row"
          : "the binding stopped being live before a typed compaction frame arrived",
      details: {
        sessionId,
        terminal: settlement.terminal,
        declaredBoundMs: CODEX_COMPACTION_WAIT_MS,
      },
    });
    return { status: "failed", reason: settlement.terminal };
  }
}
