// A Claude Code process that ended on its own: its turn ends through the run engine, then the
// session resumes on the next wait of its crash window, or, once the window fills, the restarts
// stop and the person is told. Each restart is told as a notice. A new provider build relaunches
// each session the same way, an idle one at once and a busy one when its running reply ends.

import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { CrashWindow } from "../../../../crash-window.js";
import type { DriverResumeResult, ResumeSessionParams } from "../../contract.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { ProviderBuildChange } from "../../session-control.js";
import type { ClaudeDeliveryDispatch } from "../delivery/dispatch.js";
import type { ClaudeRunRoutes } from "../run/routes.js";
import type { ClaudeDeadlineScheduler } from "./control-requests.js";
import { describeFailure } from "./errors.js";
import type { ClaudeSessionSlots } from "./slots.js";
import type {
  ClaudeRunEnginePort,
  ClaudeSessionLifecycleDependencies,
  LiveClaudeSession,
} from "./state.js";

/** What the restart path ends turns, resumes and tells through. */
export interface ClaudeSessionRestartsDependencies {
  readonly slots: ClaudeSessionSlots;
  readonly runRoutes: ClaudeRunRoutes;
  readonly runEngine: ClaudeRunEnginePort;
  /** Where each notice goes, as every delivery does. */
  readonly dispatch: ClaudeDeliveryDispatch;
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * Resumes a session through the lifecycle's own resume, slot claim included.
   */
  readonly resume: (params: ResumeSessionParams) => Promise<DriverResumeResult>;
  readonly onSessionRelaunched: ClaudeSessionLifecycleDependencies["onSessionRelaunched"];
  /** Forgets what the daemon held for the dead process: its pauses and helper holds. */
  readonly forgetProcessState: (sessionId: SessionId) => void;
  readonly scheduler: ClaudeDeadlineScheduler;
  readonly now: () => number;
}

/**
 * The resume that brings a session back on the legs and level it ran at, the person's later level
 * move included, under the account it was admitted against.
 */
function composeClaudeRelaunchParams(live: LiveClaudeSession): ResumeSessionParams {
  const legs = live.spawnBoundLegs;
  return {
    sessionId: live.sessionId,
    resumeHandle: live.providerSessionId,
    // The model the session runs on now, which a session-long switch by Claude Code moved.
    model: live.runningModel,
    // Claude Code's model id names its window, so the driver keeps no separate figure.
    largerWindow: undefined,
    mode: live.sessionMode,
    executionPosture: live.executionPosture,
    outputSpeed: live.appliedOutputSpeed,
    callbackTools: legs.callbackTools,
    subagentPolicy: legs.subagentPolicy,
    toolServers: legs.toolServers,
    outputSchema: legs.outputSchema,
    providerAccountId: live.admittedProviderAccountId ?? undefined,
    onCallbackToolCall: legs.onCallbackToolCall,
    onMcpServerStatus: legs.onMcpServerStatus,
  };
}

/** Every session's crash window and the restart each one has waiting. */
export class ClaudeSessionRestarts {
  readonly #dependencies: ClaudeSessionRestartsDependencies;
  readonly #crashWindows: Map<SessionId, CrashWindow> = new Map();
  readonly #pendingRestarts: Map<SessionId, () => void> = new Map();
  // The provider build each busy session moves to when its running reply ends.
  readonly #pendingBuildMoves: Map<SessionId, ProviderBuildChange> = new Map();
  // Set once the daemon stops: from then on no session is started again.
  #isStopped = false;

  constructor(dependencies: ClaudeSessionRestartsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Takes a process that exited while its slot still held it live. The slot is released first, so
   * no run starts on the dead process; then each run it held ends on the exit, and the session
   * restarts after its window's wait or stops restarting.
   */
  async handleUnrequestedExit(live: LiveClaudeSession, exit: ProcessExit): Promise<void> {
    const { slots, runRoutes, runEngine } = this.#dependencies;
    const sessionId = live.sessionId;
    const runIds = runRoutes.runIdsBoundTo(sessionId);
    // The restart resumes on the build installed now, so a move that waited for the turn is done.
    this.#pendingBuildMoves.delete(sessionId);
    slots.releaseExitedSession(sessionId, live.channel);
    runRoutes.retireRunRoutes(sessionId);
    runRoutes.retireChildRoutes(sessionId);
    this.#dependencies.forgetProcessState(sessionId);
    for (const runId of runIds) {
      // Ended here with the helpers beneath it, so no delivery is attributed to it after.
      runRoutes.forgetRun(runId);
      try {
        await runEngine.endTurnOnProcessExit(runId, exit);
      } catch (error) {
        this.recordReportFailure(sessionId, "the run end of a process that exited", error);
      }
    }
    if (this.#isStopped) {
      return;
    }
    const outcome = this.#crashWindowFor(sessionId).recordCrash(this.#dependencies.now());
    if ("crashLoop" in outcome) {
      await this.#reportCrashLoop(sessionId, exit);
      return;
    }
    this.#pendingRestarts.set(
      sessionId,
      this.#dependencies.scheduler(() => {
        this.#pendingRestarts.delete(sessionId);
        this.#restart(live).catch((error: unknown) => {
          this.recordReportFailure(sessionId, "the restart of a process that exited", error);
        });
      }, outcome.restartAfterMs),
    );
  }

  /** Forgets the session's crashes, so the next one counts from the first; a person's restart. */
  clearCrashWindow(sessionId: SessionId): void {
    this.#crashWindowFor(sessionId).clear();
  }

  /** Drops a restart still waiting, for a session the person closed or restarted themselves. */
  cancelPendingRestart(sessionId: SessionId): void {
    this.#pendingRestarts.get(sessionId)?.();
    this.#pendingRestarts.delete(sessionId);
  }

  /**
   * Drops every restart and build move still waiting and starts none from here, as the daemon
   * stops.
   */
  stop(): void {
    this.#isStopped = true;
    for (const sessionId of [...this.#pendingRestarts.keys()]) {
      this.cancelPendingRestart(sessionId);
    }
    this.#pendingBuildMoves.clear();
  }

  /** Forgets a closed session's crash window and any restart or build move it had waiting. */
  forgetSession(sessionId: SessionId): void {
    this.cancelPendingRestart(sessionId);
    this.#crashWindows.delete(sessionId);
    this.#pendingBuildMoves.delete(sessionId);
  }

  /**
   * Moves every live session onto the provider build that replaced the running one: an idle one at
   * once, a busy one when its running reply ends. Each is told once with `provider_updated`. The
   * idle ones move together, so one that fails strands none of the rest; rejects with every
   * failure once all have moved.
   */
  async moveToProviderBuild(change: ProviderBuildChange): Promise<void> {
    const { slots, runRoutes } = this.#dependencies;
    const idle: LiveClaudeSession[] = [];
    for (const live of slots.liveSessions()) {
      if (runRoutes.isTurnHeld(live.sessionId)) {
        this.#pendingBuildMoves.set(live.sessionId, change);
      } else {
        idle.push(live);
      }
    }
    const failures = (
      await Promise.allSettled(idle.map(async (live) => await this.#moveToBuild(live, change)))
    ).flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
    if (failures.length > 0) {
      throw new AggregateError(failures, "Moving Claude Code sessions to the new build failed");
    }
  }

  /** A session's running reply ended: a build move waiting for it goes now. */
  moveAfterTurn(live: LiveClaudeSession): void {
    const change = this.#pendingBuildMoves.get(live.sessionId);
    if (change !== undefined) {
      this.#moveToBuild(live, change).catch((error: unknown) => {
        this.recordReportFailure(live.sessionId, "the move to a new provider build", error);
      });
    }
  }

  /** Tells the person a session's provider runs again, by the daemon's restart or theirs. */
  async reportRestarted(sessionId: SessionId): Promise<void> {
    this.#dependencies.diagnostics.emit({
      provider: "claude",
      kind: "provider_restarted",
      rawWireType: null,
      dispositionReason: "the Claude Code process was started again",
      details: { sessionId },
    });
    await this.#dependencies.dispatch.send(
      {
        kind: "session_notice",
        notice: { sessionId, kind: "provider_restarted", provider: "claude" },
      },
      null,
    );
  }

  /**
   * Records a step the driver owed for a process that threw where no caller can hear it: an exit
   * and a timer both run with nobody waiting on them. `step` names the step in plain words.
   */
  recordReportFailure(sessionId: SessionId, step: string, error: unknown): void {
    this.#dependencies.diagnostics.emit({
      provider: "claude",
      kind: "process_report_failed",
      rawWireType: null,
      dispositionReason: `${step} failed: ${describeFailure(error)}`,
      details: { sessionId },
    });
  }

  // Ends the process the way a close does and resumes the conversation on the new build.
  async #moveToBuild(live: LiveClaudeSession, change: ProviderBuildChange): Promise<void> {
    const { slots, runRoutes } = this.#dependencies;
    const sessionId = live.sessionId;
    this.#pendingBuildMoves.delete(sessionId);
    if (this.#isStopped || slots.findLiveSession(sessionId)?.channel !== live.channel) {
      return;
    }
    const relaunch = composeClaudeRelaunchParams(live);
    runRoutes.retireRunRoutes(sessionId);
    this.#dependencies.forgetProcessState(sessionId);
    await slots.disposeHeldChannel(sessionId, live.channel);
    const result = await this.#dependencies.resume(relaunch);
    this.#dependencies.onSessionRelaunched(sessionId, result);
    if (result.status === "resumed") {
      await this.#dependencies.dispatch.send(
        {
          kind: "session_notice",
          notice: {
            sessionId,
            kind: "provider_updated",
            provider: "claude",
            fromVersion: change.fromVersion,
            toVersion: change.toVersion,
          },
        },
        null,
      );
    }
  }

  async #restart(live: LiveClaudeSession): Promise<void> {
    const sessionId = live.sessionId;
    // A create, resume or close that reached the session during the wait owns it now.
    if (this.#isStopped || this.#dependencies.slots.slotFor(sessionId) !== undefined) {
      return;
    }
    const result = await this.#dependencies.resume(composeClaudeRelaunchParams(live));
    this.#dependencies.onSessionRelaunched(sessionId, result);
    if (result.status === "resumed") {
      await this.reportRestarted(sessionId);
    }
  }

  async #reportCrashLoop(sessionId: SessionId, exit: ProcessExit): Promise<void> {
    const ending =
      exit.signal === undefined ? { exitCode: exit.exitCode } : { signal: exit.signal };
    this.#dependencies.diagnostics.emit({
      provider: "claude",
      kind: "provider_crash_loop",
      rawWireType: null,
      dispositionReason: "the Claude Code process ended on its own too often to restart again",
      details: { sessionId, ...ending },
    });
    await this.#dependencies.dispatch.send(
      {
        kind: "session_notice",
        notice: { sessionId, kind: "provider_crash_loop", provider: "claude", ...ending },
      },
      null,
    );
  }

  #crashWindowFor(sessionId: SessionId): CrashWindow {
    const existing = this.#crashWindows.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const window = new CrashWindow();
    this.#crashWindows.set(sessionId, window);
    return window;
  }
}
