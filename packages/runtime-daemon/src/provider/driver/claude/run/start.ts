// A run's start on Claude Code: its opening text written to the session's live process as typed,
// one turn at a time, after the output-speed level the run asks for is applied. A turn the daemon
// starts itself, such as a goal or a review, is started as the session's own run through the run
// engine before its text is written, at the session's current posture, so every row of the turn
// has a run to belong to.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { RunEngine } from "../../../../session/run/engine.js";
import type { OutboundText } from "../../../outbound-text.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { StartRunParams } from "../../contract.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import type { ClaudeHandshakeRegister } from "../handshake-register.js";
import { applyClaudeOutputSpeed, resolveClaudeOutputSpeed } from "../output-speed.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import type { ClaudeSessionSlots } from "../session/slots.js";
import type { LiveClaudeSession } from "../session/state.js";
import { attemptClaudeFrameWrite } from "../session/stdin-write.js";
import type { ClaudeRunDispatchResolver } from "../session/transport.js";
import { assertClaudeSpawnBoundRealization } from "../spawn/legs.js";
import type { ClaudeSentPrompts } from "./prompts.js";
import type { ClaudeBoundRun, ClaudeRunRoutes } from "./routes.js";

/**
 * What a turn the daemon starts on a session itself opens with: text written to the session's own
 * process under the message id a later cut names, or a turn run apart from that process, started
 * once its run is bound and delivered on that run.
 */
export type ClaudeDaemonTurnOpening =
  | { readonly kind: "text"; readonly text: OutboundText; readonly messageId: string }
  | { readonly kind: "apart"; readonly start: (run: ClaudeBoundRun) => void };

/** What a run's start reads and writes through. */
export interface ClaudeRunStartDependencies {
  readonly runDispatchResolver: ClaudeRunDispatchResolver;
  readonly runEngine: Pick<RunEngine, "startDaemonTurn">;
  readonly slots: ClaudeSessionSlots;
  readonly runRoutes: ClaudeRunRoutes;
  readonly handshakes: ClaudeHandshakeRegister;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly prompts: ClaudeSentPrompts;
}

// The run a turn's text opens, on the session and binding it is attributed on.
interface ClaudeTurnRun {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly bindingId: string;
}

/** Starts runs on live Claude sessions. */
export class ClaudeRunStart {
  readonly #dependencies: ClaudeRunStartDependencies;

  constructor(dependencies: ClaudeRunStartDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Writes the run's opening text to its session's live channel, as typed. Claude Code takes one
   * turn at a time, so a run is refused while it or another run holds the session's turn. Throws
   * when the run cannot be dispatched, and rethrows the failed write's cause; nothing is re-sent.
   */
  async startRun(params: StartRunParams): Promise<void> {
    const { runDispatchResolver, slots } = this.#dependencies;
    const runDispatch = await runDispatchResolver.resolveRunDispatch(params);
    if (runDispatch === undefined) {
      throw new ClaudeSessionUnavailableError("run_dispatch_unresolved", { runId: params.runId });
    }

    const live = slots.findLiveSession(runDispatch.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: runDispatch.sessionId,
        runId: params.runId,
      });
    }

    assertClaudeSpawnBoundRealization(params, live);
    await this.#openTurn(
      live,
      { runId: params.runId, sessionId: runDispatch.sessionId, bindingId: runDispatch.bindingId },
      { text: runDispatch.openingText, origin: "human_text" },
      runDispatch.messageId,
      // The next run carries the agent's own level, which differs and so is sent again.
      params.outputSpeedForTurn ?? params.outputSpeed,
    );
  }

  /**
   * Starts a turn the daemon starts on a session itself as the session's own run, at the session's
   * current posture, and resolves with the run's id once its opening is written and the run is
   * running. A text opening is refused, before any run exists, while a run holds the session's
   * turn, and every opening on a session holding no posture. Throws as {@link startRun} does, the
   * run then ended `failed` by the run engine.
   */
  async startDaemonTurn(live: LiveClaudeSession, opening: ClaudeDaemonTurnOpening): Promise<RunId> {
    const { runEngine, runDispatchResolver, slots } = this.#dependencies;
    const sessionId = live.sessionId;
    const executionPosture = live.executionPosture;
    if (executionPosture === undefined) {
      throw new ClaudeSessionUnavailableError("execution_posture_absent", { sessionId });
    }
    if (opening.kind === "text") {
      this.#assertTurnFree(sessionId, undefined);
    }
    return await runEngine.startDaemonTurn({
      sessionId,
      provider: CLAUDE_DRIVER_NAME,
      admittedProviderAccountId: live.admittedProviderAccountId,
      executionPosture,
      startTurn: async (runId) => {
        const { bindingId } = await runDispatchResolver.openDaemonTurnBinding(runId, sessionId);
        if (opening.kind === "apart") {
          opening.start({ runId, bindingId });
          return;
        }
        // Re-read: the session may have closed or moved to another process while the run started.
        const current = slots.findLiveSession(sessionId);
        if (current === undefined) {
          throw new ClaudeSessionUnavailableError("no_live_session", { sessionId, runId });
        }
        await this.#openTurn(
          current,
          { runId, sessionId, bindingId },
          opening.text,
          opening.messageId,
          undefined,
        );
      },
    });
  }

  // Claude Code's terminal frame names no run, so a second turn on the session, or a command's,
  // could not be told apart from the first; refused before anything is written, so the caller may
  // start it again.
  #assertTurnFree(sessionId: SessionId, runId: RunId | undefined): void {
    if (this.#dependencies.runRoutes.isTurnHeld(sessionId)) {
      throw new ClaudeSessionUnavailableError("session_turn_in_flight", {
        sessionId,
        ...(runId === undefined ? {} : { runId }),
      });
    }
  }

  // Binds the run as the session's one turn and writes its opening text, after the output-speed
  // level it asks for.
  async #openTurn(
    live: LiveClaudeSession,
    run: ClaudeTurnRun,
    text: OutboundText,
    messageId: string,
    outputSpeed: string | undefined,
  ): Promise<void> {
    const { slots, runRoutes, handshakes, diagnostics } = this.#dependencies;
    const { runId, sessionId, bindingId } = run;
    // The run route is the turn's hold: bound here, retired by the turn's terminal. A run already
    // holding one is refused before the session check, so its caller learns which run is busy.
    if (runRoutes.sessionIdFor(runId) !== undefined) {
      throw new ClaudeSessionUnavailableError("run_already_dispatched", { sessionId, runId });
    }
    this.#assertTurnFree(sessionId, runId);

    // Bound before any await, so the hold covers the output-speed request below, and before the
    // write, since an interrupt may race the text on the wire and must find a route.
    runRoutes.bindRun(runId, sessionId, bindingId);
    // Sent once, before the turn it governs, and only when the run's level differs from the one
    // the process accepted. A refusal runs the turn on the level the process holds.
    if (
      outputSpeed !== undefined &&
      resolveClaudeOutputSpeed(outputSpeed) !== live.appliedOutputSpeed
    ) {
      try {
        live.appliedOutputSpeed =
          (await applyClaudeOutputSpeed(live.channel, sessionId, outputSpeed, diagnostics)) ??
          live.appliedOutputSpeed;
      } catch (cause) {
        runRoutes.unbindRun(runId);
        throw cause;
      }
      // Re-read after the request: a close or rewind in that window retired this channel and its
      // routes, so nothing is armed or written on it.
      if (slots.findLiveSession(sessionId)?.channel !== live.channel) {
        runRoutes.unbindRun(runId);
        throw new ClaudeSessionUnavailableError("no_live_session", { sessionId, runId });
      }
    }
    // Armed before the write, so the turn's handshake cannot outrun it.
    handshakes.armRunOutputSpeed(sessionId, live.providerSessionId, runId);
    const attempt = await attemptClaudeFrameWrite(live.channel, text, messageId);
    if (attempt.settled === "written") {
      this.#dependencies.prompts.recordSent(sessionId, messageId);
      return;
    }
    handshakes.disarmRunOutputSpeed(sessionId);
    // Bytes that may have been taken can still start a turn, whose terminal releases the hold; a
    // write that never left, or a channel past its last terminal, releases it now.
    if (attempt.delivery === "unsent" || live.channel.isClosed) {
      runRoutes.unbindRun(runId);
    }
    throw attempt.cause;
  }
}
