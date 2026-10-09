// The Codex lifecycle's session slots: which record each session holds, the transition in flight
// on it, the per-session routing band, and how a session is let go. Every establishment, close and
// disposal runs inside a claimed slot, held until it fully settles.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import { TerminalEmissionGate } from "../../../terminal-emission-gate.js";
import { ThreadFrameRouter } from "../../../thread-frame-router.js";
import { UsageDeltaAccountant } from "../../../usage-delta-accountant.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import type { CodexProviderCommandCache } from "../commands.js";
import type { CodexRunPauses } from "../hooks/pause.js";
import type { CodexRunRoutes } from "../run/routes.js";
import type { CodexService } from "../service/supervisor.js";
import { reportDiagnosticFromDetachedFrame } from "../transport/diagnostics.js";
import { endCodexRunningCommands } from "./background-terminals.js";
import type { CodexConversationRelease } from "./conversation-release.js";
import {
  CodexSessionAlreadyLiveError,
  type CodexSessionSlotState,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./errors.js";
import {
  CODEX_THREAD_FRAME_ROUTER_CONFIG,
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexRoutableFrame,
  type CodexSessionRecord,
  type CodexSessionTransition,
  type CodexSessionTransitionKind,
  newestActiveTurnForRun,
} from "./state.js";

/** Deadline for the courtesy `thread/unsubscribe`; short so a wedged service cannot hold close. */
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** What the slots release when a session is let go. */
export interface CodexSessionSlotsDependencies {
  readonly options: Pick<CodexLifecycleOptions, "reportDiagnostic" | "diagnostics">;
  readonly runRoutes: CodexRunRoutes;
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly providerCommands: CodexProviderCommandCache;
  readonly pauses: CodexRunPauses;
  /** Keeps a conversation the session moved off while a command of it runs, past the session. */
  readonly release: Pick<CodexConversationRelease, "releaseSessionThreads">;
  /** Told each record that stops being its session's, replaced or let go. */
  readonly onRecordLeft: (record: CodexSessionRecord) => void;
}

/** Every session's record, slot, routing band and close latch. */
export class CodexSessionSlots {
  readonly #options: CodexSessionSlotsDependencies["options"];
  readonly #runRoutes: CodexRunRoutes;
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #providerCommands: CodexProviderCommandCache;
  readonly #pauses: CodexRunPauses;
  readonly #release: CodexSessionSlotsDependencies["release"];
  readonly #onRecordLeft: (record: CodexSessionRecord) => void;
  readonly #records = new Map<SessionId, CodexSessionRecord>();
  readonly #transitions = new Map<SessionId, CodexSessionTransition>();
  // Keyed beside the records: a frame or a close can arrive while the slot is establishing,
  // before a record exists.
  readonly #terminalEmissionGates = new Map<SessionId, TerminalEmissionGate>();
  readonly #frameRouters = new Map<SessionId, ThreadFrameRouter<CodexRoutableFrame>>();
  readonly #usageAccountants = new Map<SessionId, UsageDeltaAccountant>();

  constructor(dependencies: CodexSessionSlotsDependencies) {
    this.#options = dependencies.options;
    this.#runRoutes = dependencies.runRoutes;
    this.#pendingCompactions = dependencies.pendingCompactions;
    this.#providerCommands = dependencies.providerCommands;
    this.#pauses = dependencies.pauses;
    this.#release = dependencies.release;
    this.#onRecordLeft = dependencies.onRecordLeft;
  }

  /** The record a session holds now, mid-transition included, or `undefined`. */
  recordFor(sessionId: SessionId): CodexSessionRecord | undefined {
    return this.#records.get(sessionId);
  }

  /** Every record on one service. */
  recordsOn(service: CodexService): CodexSessionRecord[] {
    return [...this.#records.values()].filter((record) => record.service === service);
  }

  /** Installs a just-established record as the session's. */
  install(record: CodexSessionRecord): void {
    const replaced = this.#records.get(record.sessionId);
    this.#records.set(record.sessionId, record);
    if (replaced !== undefined && replaced !== record) {
      this.#onRecordLeft(replaced);
    }
  }

  /** Throws `CodexSessionAlreadyLiveError` when any holder occupies the slot; nothing awaits. */
  assertFree(sessionId: SessionId): void {
    const holderState = this.#describeHolder(sessionId);
    if (holderState !== undefined) {
      throw new CodexSessionAlreadyLiveError(sessionId, holderState);
    }
  }

  /** Whether a record or a transition occupies the slot. */
  isOccupied(sessionId: SessionId): boolean {
    return this.#describeHolder(sessionId) !== undefined;
  }

  /**
   * True when `record` is still the session's settled, live holder; identity on the records alone
   * would call a record mid-teardown usable.
   */
  stillHolds(record: CodexSessionRecord): boolean {
    return (
      this.#describeHolder(record.sessionId) === "live" &&
      this.#records.get(record.sessionId) === record
    );
  }

  /**
   * Claims the session slot in one state and runs the transition behind any predecessor. The only
   * way a slot is taken. Reads the predecessor and publishes the claim in one synchronous run: an
   * `await` between them lets two same-tick callers both see an empty slot.
   */
  async claim<TSettled>(
    sessionId: SessionId,
    kind: CodexSessionTransitionKind,
    runTransition: () => Promise<TSettled>,
  ): Promise<TSettled> {
    const predecessor = this.#transitions.get(sessionId)?.settled ?? Promise.resolve();
    const transition = predecessor.then(runTransition);
    const claim: CodexSessionTransition = {
      kind,
      settled: transition.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.#transitions.set(sessionId, claim);
    try {
      return await transition;
    } finally {
      // Identity-checked: a later caller chains onto this claim and publishes its own.
      if (this.#transitions.get(sessionId) === claim) {
        this.#transitions.delete(sessionId);
      }
    }
  }

  /** The session's live record. Throws `CodexTransportError` mid-transition or with none. */
  require(sessionId: SessionId): CodexSessionRecord {
    // Both transition states refuse: a record stays installed across its whole transition, so a
    // turn could reach a thread a resume is about to replace.
    const holderState = this.#describeHolder(sessionId);
    if (holderState === "closing") {
      throw new CodexTransportError(`Codex session "${sessionId}" is being torn down.`, {
        sessionId,
        holderState,
      });
    }
    if (holderState === "establishing") {
      throw new CodexTransportError(
        `Codex session "${sessionId}" is being re-established; the conversation it runs on is ` +
          `about to change.`,
        { sessionId, holderState },
      );
    }
    const record = this.#records.get(sessionId);
    if (record === undefined) {
      throw new CodexTransportError(`No live Codex session for "${sessionId}".`, { sessionId });
    }
    return record;
  }

  /** The live turn a steer, interrupt or pause acts on. Throws `CodexTransportError` with none. */
  requireActiveTurn(runId: RunId): { record: CodexSessionRecord; turnId: string } {
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    const record = sessionId === undefined ? undefined : this.#records.get(sessionId);
    const turnId = record === undefined ? undefined : newestActiveTurnForRun(record, runId);
    if (record === undefined || turnId === undefined) {
      throw new CodexTransportError(`No active Codex turn for run "${runId}".`, { runId });
    }
    return { record, turnId };
  }

  /** The intended-close gate, which stamps `intendedClose` on a terminal; read live. */
  terminalEmissionGateFor(sessionId: SessionId): TerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new TerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
  }

  /** The thread-frame router for one session; read live so a widened thread set is seen. */
  frameRouterFor(sessionId: SessionId): ThreadFrameRouter<CodexRoutableFrame> {
    const existing = this.#frameRouters.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const router = new ThreadFrameRouter<CodexRoutableFrame>({
      provider: CODEX_DRIVER_NAME,
      diagnostics: this.#options.diagnostics,
      config: CODEX_THREAD_FRAME_ROUTER_CONFIG,
    });
    this.#frameRouters.set(sessionId, router);
    return router;
  }

  /** Admits a conversation the session moved off, held for its running commands, to its band. */
  admitHeldThread(sessionId: SessionId, threadId: string): void {
    this.frameRouterFor(sessionId).admitHeldThread(threadId);
  }

  /** Stops admitting a held conversation; a band the session's close dropped is left so. */
  releaseHeldThread(sessionId: SessionId, threadId: string): void {
    this.#frameRouters.get(sessionId)?.releaseHeldThread(threadId);
  }

  /** The usage-delta accountant for one session. */
  usageAccountantFor(sessionId: SessionId): UsageDeltaAccountant {
    const existing = this.#usageAccountants.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const accountant = new UsageDeltaAccountant({
      provider: CODEX_DRIVER_NAME,
      diagnostics: this.#options.diagnostics,
    });
    this.#usageAccountants.set(sessionId, accountant);
    return accountant;
  }

  /**
   * Closes a session: its running commands end, then it unsubscribes, and the service stays for
   * the others. Idempotent: a session with nothing held resolves.
   */
  async close(sessionId: SessionId): Promise<void> {
    // The latch comes first so every later terminal counts as clean.
    this.terminalEmissionGateFor(sessionId).signalIntendedClose();
    if (this.isOccupied(sessionId)) {
      // A close during establishment chains behind it; no establishment path closes a session,
      // so the wait cannot deadlock.
      await this.claim(sessionId, "closing", async () => {
        await this.#letGo(sessionId);
      });
    }
    // After the release: a terminal it provokes must still find the latch set.
    this.#forgetBand(sessionId);
  }

  /**
   * Lets a session go when a turn may be live on it with no route, such as a `turn/start` whose
   * answer was lost. Only its own conversation ends; the service and its other sessions stay.
   * Scoped to the record, so a resume that already replaced it is untouched.
   */
  async dispose(record: CodexSessionRecord): Promise<void> {
    await this.claim(record.sessionId, "closing", async () => {
      if (this.#records.get(record.sessionId) === record) {
        await this.#letGo(record.sessionId);
      }
    });
  }

  /**
   * Releases a held record: routes and waits first, so nothing reaches it after; then on a
   * running service its commands end and it unsubscribes. The record leaves in a `finally`, so a
   * failed step cannot leave it stuck.
   */
  async #letGo(sessionId: SessionId): Promise<void> {
    const record = this.#records.get(sessionId);
    if (record === undefined) {
      // The establishment this close chained behind failed and released its thread.
      return;
    }
    this.#runRoutes.forgetRunRoutes(sessionId);
    this.#pauses.forgetSession(sessionId);
    try {
      if (record.service.isRunning) {
        await endCodexRunningCommands(
          record.service,
          record.threadId,
          this.#options.reportDiagnostic,
          { clean: true },
        );
        try {
          await record.service.request(
            "thread/unsubscribe",
            { threadId: record.threadId },
            UNSUBSCRIBE_TIMEOUT_MS,
          );
        } catch (cause) {
          reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
            kind: "teardown-step-failed",
            step: "thread-unsubscribe",
            detail: normalizeProviderFailureDetail(cause),
          });
        }
      }
    } finally {
      // A conversation the session moved off stays routed until the command it runs ends.
      this.#release.releaseSessionThreads(record.service, sessionId);
      this.#records.delete(sessionId);
      this.#pendingCompactions.releaseBinding(codexCompactionWaitKey(sessionId, record.threadId));
      this.#providerCommands.discardProviderCommandEnumeration(sessionId);
      this.#onRecordLeft(record);
    }
  }

  #forgetBand(sessionId: SessionId): void {
    this.#terminalEmissionGates.delete(sessionId);
    this.#frameRouters.delete(sessionId);
    this.#usageAccountants.delete(sessionId);
    this.#providerCommands.discardProviderCommandEnumeration(sessionId);
  }

  /** Names the current holder of a session slot, or `undefined` when it is free. */
  #describeHolder(sessionId: SessionId): CodexSessionSlotState | undefined {
    // Transition first: during a resume both views are occupied and the old record stays
    // installed, so the in-flight kind is the more specific truth.
    const transition = this.#transitions.get(sessionId);
    if (transition !== undefined) {
      return transition.kind;
    }
    return this.#records.has(sessionId) ? "live" : undefined;
  }
}
