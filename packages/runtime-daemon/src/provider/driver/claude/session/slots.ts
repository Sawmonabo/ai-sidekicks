// Every Claude session's slot, the one registry that says whether a session's process is coming
// up, live, going down or refusing to die, with the per-session state that lives and dies with the
// slot: its routing band and its intended-close gate. Claims read and write with no await between,
// so check-then-act is atomic.

import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import { TerminalEmissionGate } from "../../../terminal-emission-gate.js";
import { ThreadFrameRouter, type ThreadFrameRoute } from "../../../thread-frame-router.js";
import { UsageDeltaAccountant } from "../../../usage-delta-accountant.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { MoveSessionToForkResult } from "../../contract.js";
import type { ClaudeDeliveryDispatch } from "../delivery/dispatch.js";
import type { ClaudeHandshakeRegister } from "../handshake-register.js";
import type { ClaudeRunRoutes } from "../run/routes.js";
import {
  CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
  type ClaudeRoutableFrame,
  type ClaudeSessionRoutingBand,
  type ClaudeSessionSlot,
  type LiveClaudeSession,
} from "./state.js";
import type {
  ClaudeInboundFrameObservation,
  ClaudeInboundRequestEvent,
  ClaudeProviderProcess,
} from "./transport.js";

// Why a run whose turn a rewind superseded before Claude Code settled it ended failed.
const CLAUDE_SUPERSEDED_RUN_DETAIL =
  "The runtime binding carrying a user's text for this run was superseded by a rewind before " +
  "the provider settled the turn, so whether those words reached the model was never " +
  "established.";

/**
 * What a live session's channel reports, each already gated to the channel the slot holds: a
 * disposed, quarantined or replaced channel can still fire, and its reports are dropped here.
 */
interface ClaudeLiveSessionListeners {
  /** The session's turn ended on a terminal stream frame. */
  readonly onTurnTerminal: (live: LiveClaudeSession) => void;
  readonly onInboundFrame: (
    band: ClaudeSessionRoutingBand,
    live: LiveClaudeSession,
    observation: ClaudeInboundFrameObservation,
  ) => ThreadFrameRoute;
  /** A frame the router delivered, whole and untrusted, with the route it was delivered under. */
  readonly onDeliveredFrame: (
    live: LiveClaudeSession,
    frame: Readonly<Record<string, unknown>>,
    route: ThreadFrameRoute,
  ) => void;
  readonly onInboundRequest: (live: LiveClaudeSession, event: ClaudeInboundRequestEvent) => void;
  /** The process exited while the slot still held it live: nothing in the daemon asked it to. */
  readonly onUnrequestedExit: (live: LiveClaudeSession, exit: ProcessExit) => void;
}

/** What the slot registry is built over. */
export interface ClaudeSessionSlotsDependencies {
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly runRoutes: ClaudeRunRoutes;
  readonly handshakes: ClaudeHandshakeRegister;
  readonly pendingCompactions: PendingCompactionRegistry;
  /** Where a superseded run's end goes, as every run move does. */
  readonly dispatch: ClaudeDeliveryDispatch;
  /** Base registers and the session's own thread identity, set before any frame is metered. */
  readonly bindSessionThread: (band: ClaudeSessionRoutingBand, live: LiveClaudeSession) => void;
  readonly listeners: ClaudeLiveSessionListeners;
}

/** One slot per session, with the routing band and intended-close gate that share its life. */
export class ClaudeSessionSlots {
  readonly #slots: Map<SessionId, ClaudeSessionSlot> = new Map();
  // The producer half of the intended-close signal, signaled at the top of a close before the
  // channel is disposed, so the `result/*` it provokes reads as a clean shutdown. Keyed beside the
  // slot map because the intent must be recordable while the slot holds no live session.
  readonly #terminalEmissionGates: Map<SessionId, TerminalEmissionGate> = new Map();
  // A session's router and accountant, in one map so they are created and released together.
  readonly #routingBands: Map<SessionId, ClaudeSessionRoutingBand> = new Map();
  // How a rewound predecessor's process exited while its slot was claimed for the rewind, so a
  // predecessor restored after a failed rewind is not taken for a live one.
  readonly #exitsDuringRewind: Map<ClaudeProviderProcess, ProcessExit> = new Map();
  readonly #dependencies: ClaudeSessionSlotsDependencies;

  constructor(dependencies: ClaudeSessionSlotsDependencies) {
    this.#dependencies = dependencies;
  }

  /** The session's slot, or `undefined` for EMPTY. */
  slotFor(sessionId: SessionId): ClaudeSessionSlot | undefined {
    return this.#slots.get(sessionId);
  }

  /** Every session that holds a slot, in any state. */
  sessionIds(): SessionId[] {
    return [...this.#slots.keys()];
  }

  /** Every session whose slot is live. */
  liveSessions(): LiveClaudeSession[] {
    return [...this.#slots.values()].flatMap((slot) =>
      slot.state === "live" ? [slot.session] : [],
    );
  }

  /**
   * Only a live slot yields a session: no run may start in a process that is coming up, going down
   * or refusing to die.
   */
  findLiveSession(sessionId: SessionId): LiveClaudeSession | undefined {
    const slot = this.#slots.get(sessionId);
    return slot?.state === "live" ? slot.session : undefined;
  }

  /**
   * The thread-frame router for one session, or `undefined` when it holds no routing band.
   * Non-creating: a get-or-create accessor would let a call after close resurrect a band.
   */
  routingBandFor(sessionId: SessionId): ClaudeSessionRoutingBand | undefined {
    return this.#routingBands.get(sessionId);
  }

  /**
   * The terminal-emission gate for one session, get-or-create, so the intent latch survives
   * whichever of close and establishment reaches the session first.
   */
  intendedCloseGateFor(sessionId: SessionId): TerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new TerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
  }

  /** Drops the session's intended-close gate; a double close leaves none piling up. */
  forgetIntendedCloseGate(sessionId: SessionId): void {
    this.#terminalEmissionGates.delete(sessionId);
  }

  /**
   * Names the current holder of a session slot for a refusal detail, or `undefined` when the slot
   * is free. One predicate, so every entry point agrees on what "taken" means.
   */
  describeSlotHolder(sessionId: SessionId): string | undefined {
    const slot = this.#slots.get(sessionId);
    if (slot === undefined) {
      return undefined;
    }
    // Exhaustive over the union: a new state must decide what a racing create sees.
    switch (slot.state) {
      case "live":
        return `A live Claude session is already bound to session ${sessionId};`;
      case "establishing":
        return `A create or resume for session ${sessionId} is already in flight;`;
      case "closing":
        return `A close for session ${sessionId} is still disposing its Claude process;`;
      case "quarantined":
        return (
          `The Claude process for session ${sessionId} refused to exit and is quarantined ` +
          `pending a successful close;`
        );
    }
  }

  /**
   * Installs an adopted channel as the session's live slot and registers its listeners. Band, then
   * slot, then listeners: registration can deliver a frame re-entrantly, which needs a band to hold
   * it and a slot for the identity gate. The previous slot is restored if registration throws.
   */
  registerLiveSession(live: LiveClaudeSession): void {
    const previousSlot = this.#slots.get(live.sessionId);
    const bandExistedBefore = this.#routingBands.has(live.sessionId);
    const band = this.#ensureRoutingBand(live.sessionId);
    this.#slots.set(live.sessionId, { state: "live", session: live });
    // Discarded where all establishment paths converge, before listeners register: a resume reuses
    // its predecessor's `providerSessionId`, so a surviving record would match. Not restored on
    // rollback, since a failed adoption already disposed its source.
    this.#dependencies.handshakes.forgetHandshake(live.sessionId);
    // Before the listeners, so a `system/init` delivered during registration replaces it.
    this.#dependencies.handshakes.holdFastMode(
      live.sessionId,
      live.providerSessionId,
      live.initialize.fastMode,
    );
    try {
      this.#registerListeners(band, live);
    } catch (error) {
      // Restores rather than deletes: the previous value is the caller's `establishing` claim, and
      // deleting it would publish an EMPTY slot a rewind could not recognize.
      if (previousSlot === undefined) {
        this.#slots.delete(live.sessionId);
      } else {
        this.#slots.set(live.sessionId, previousSlot);
      }
      // Only a band this call created is released: a rewind's successor joins the predecessor's
      // band, and dropping it would zero registers about to be restored.
      if (!bandExistedBefore) {
        this.#routingBands.delete(live.sessionId);
      }
      throw error;
    }
  }

  /**
   * Claims the slot synchronously, before `establish` is awaited, so no caller sees a free slot
   * while it spawns; releases the claim however it settles.
   */
  async withSessionSlotClaimed<TEstablished>(
    sessionId: SessionId,
    establish: () => Promise<TEstablished>,
  ): Promise<TEstablished> {
    const establishment = establish();
    // Rejection-swallowed: chainers await it only to sequence, and a stored rejecting promise would
    // go unhandled.
    const settled = establishment.then(
      () => undefined,
      () => undefined,
    );
    // No channel: a create or resume starts from EMPTY.
    this.#slots.set(sessionId, { state: "establishing", settled, channel: undefined });
    try {
      return await establishment;
    } finally {
      // A successful establishment has already overwritten the slot; only a failed one is cleared,
      // and only if the claim is ours.
      const slot = this.#slots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#slots.delete(sessionId);
      }
    }
  }

  /**
   * Claims a live slot for a rewind and restores the predecessor if it installs no successor.
   * Unlike `withSessionSlotClaimed` it must not clear on failure: a rewind starts from live, and
   * an EMPTY slot for a running process would let the next create spawn a second one.
   */
  async withRewindSlotClaimed(
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
    rewind: () => Promise<MoveSessionToForkResult>,
  ): Promise<MoveSessionToForkResult> {
    const rewinding = rewind();
    const settled = rewinding.then(
      () => undefined,
      () => undefined,
    );
    // The predecessor's channel stays bound: its process is still up and emitting frames that
    // belong to this session's transcript.
    this.#slots.set(sessionId, {
      state: "establishing",
      settled,
      channel: predecessor.channel,
    });
    try {
      return await rewinding;
    } finally {
      // Identity-checked, so a successful rewind or a concurrent close is left alone.
      const slot = this.#slots.get(sessionId);
      const exit = this.#exitsDuringRewind.get(predecessor.channel);
      this.#exitsDuringRewind.delete(predecessor.channel);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#slots.set(sessionId, { state: "live", session: predecessor });
        // A predecessor that died meanwhile takes the path any unrequested exit takes.
        if (exit !== undefined) {
          this.#dependencies.listeners.onUnrequestedExit(predecessor, exit);
        }
      }
    }
  }

  /**
   * Holds the slot as CLOSING for the whole await, so it never reads EMPTY while a process is
   * dying and a concurrent create cannot spawn a replacement beside it. A rejected disposal leaves
   * the slot QUARANTINED with the channel, the only handle on a process that would not exit.
   */
  async disposeHeldChannel(sessionId: SessionId, channel: ClaudeProviderProcess): Promise<void> {
    let markSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#slots.set(sessionId, { state: "closing", settled });
    // Pushed at the CLOSING write, before the await, so a waiting caller learns now; every close
    // path funnels through here.
    this.#dependencies.pendingCompactions.releaseBinding(sessionId);
    try {
      await channel.dispose("session_closed");
      this.#releaseSessionState(sessionId);
    } catch (error) {
      this.#slots.set(sessionId, { state: "quarantined", channel });
      throw error;
    } finally {
      // After the state write on both paths, so a chainer resuming here sees the settled state.
      markSettled();
    }
  }

  /**
   * Empties the slot of a process that already exited, releasing what it held; a slot that no
   * longer holds `channel` is left alone.
   */
  releaseExitedSession(sessionId: SessionId, channel: ClaudeProviderProcess): void {
    if (this.findLiveSession(sessionId)?.channel !== channel) {
      return;
    }
    this.#dependencies.pendingCompactions.releaseBinding(sessionId);
    this.#releaseSessionState(sessionId);
  }

  /**
   * Releases a rewound predecessor once its successor is adopted, before its channel is disposed.
   * A run still holding the predecessor's turn is failed before its route retires: no terminal can
   * end it (the successor's hook is identity-gated), so it would otherwise never end.
   */
  releaseSupersededPredecessor(sessionId: SessionId): void {
    this.retireSupersededTurn(sessionId);
    // The predecessor is going away, so its armed compaction waits can never see their evidence.
    // None exist for the successor: this method holds the rewind slot claim, and a compaction
    // needs a settled live slot.
    this.#dependencies.pendingCompactions.releaseBinding(sessionId);
  }

  /**
   * Ends each run holding the session's turn failed, as superseded by a rewind, and retires its
   * route and binding: no terminal can reach it after the turn it held was cut or replaced.
   */
  retireSupersededTurn(sessionId: SessionId): void {
    const runRoutes = this.#dependencies.runRoutes;
    for (const runId of runRoutes.runIdsBoundTo(sessionId)) {
      this.#reportSupersededRun(sessionId, runId);
      runRoutes.forgetRun(runId);
    }
    runRoutes.retireRunRoutes(sessionId);
  }

  // The slot, gate, band and handshake of a session whose process is gone.
  #releaseSessionState(sessionId: SessionId): void {
    this.#slots.delete(sessionId);
    // The gate dies with its session; a later terminal names a run no slot can settle.
    this.#terminalEmissionGates.delete(sessionId);
    // A surviving router would answer the next session with a stale thread registry.
    this.#routingBands.delete(sessionId);
    // A live read of a process that has exited; keeping it would be a stale registry.
    this.#dependencies.handshakes.forgetHandshake(sessionId);
  }

  // Builds the session's routing band if it holds none; reached only from registration.
  #ensureRoutingBand(sessionId: SessionId): ClaudeSessionRoutingBand {
    const existing = this.#routingBands.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const band: ClaudeSessionRoutingBand = {
      router: new ThreadFrameRouter<ClaudeRoutableFrame>({
        provider: "claude",
        diagnostics: this.#dependencies.diagnostics,
        config: CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
      }),
      accountant: new UsageDeltaAccountant({
        provider: "claude",
        diagnostics: this.#dependencies.diagnostics,
      }),
    };
    this.#routingBands.set(sessionId, band);
    return band;
  }

  // The listener half of registration, separated so the slot rollback has one thing to guard.
  #registerListeners(band: ClaudeSessionRoutingBand, live: LiveClaudeSession): void {
    const listeners = this.#dependencies.listeners;
    // Identity-gated: a disposed, quarantined or replaced channel can still fire, and an ungated
    // listener would act on the slot's current session. This also makes it a no-op during CLOSING.
    const holdsChannel = (): boolean =>
      this.findLiveSession(live.sessionId)?.channel === live.channel;
    live.channel.onTurnTerminal(() => {
      if (holdsChannel()) {
        listeners.onTurnTerminal(live);
      }
    });
    // Fail-closed: a frame from a channel the daemon has released must not project.
    live.channel.onInboundFrame((observation): ThreadFrameRoute => {
      if (!this.#isChannelCurrentlyBound(live.sessionId, live.channel)) {
        return {
          decision: "quarantined",
          reason:
            "frame arrived on a channel this session no longer holds; refused rather than " +
            "projected into whichever session occupies the slot now",
        };
      }
      // While the channel is bound, the session's band is this one: only a close or a failed
      // registration releases it, and both unbind the channel.
      return listeners.onInboundFrame(band, live, observation);
    });
    live.channel.onDeliveredFrame((frame, route) => {
      if (this.#isChannelCurrentlyBound(live.sessionId, live.channel)) {
        listeners.onDeliveredFrame(live, frame, route);
      }
    });
    live.channel.onInboundRequest((event) => {
      if (this.#isChannelCurrentlyBound(live.sessionId, live.channel)) {
        listeners.onInboundRequest(live, event);
      }
    });
    live.channel.onExit((exit) => {
      if (holdsChannel()) {
        listeners.onUnrequestedExit(live, exit);
        return;
      }
      const slot = this.#slots.get(live.sessionId);
      if (slot?.state === "establishing" && slot.channel === live.channel) {
        this.#exitsDuringRewind.set(live.channel, exit);
      }
    });
    this.#dependencies.bindSessionThread(band, live);
    // Through the accessor a close uses, so a close signaled during establishment finds its latch.
    this.intendedCloseGateFor(live.sessionId);
  }

  /**
   * Whether this channel is bound to this session in any state the session can continue from.
   * Wider than `findLiveSession`, for frame routing only: a rewind holds an `establishing` slot
   * while the predecessor keeps emitting, and refusing those frames would leave a transcript hole.
   */
  #isChannelCurrentlyBound(sessionId: SessionId, channel: ClaudeProviderProcess): boolean {
    const slot = this.#slots.get(sessionId);
    if (slot === undefined) {
      return false;
    }
    // Exhaustive: a new state forces a routing decision instead of defaulting to refused.
    switch (slot.state) {
      case "live":
        return slot.session.channel === channel;
      case "establishing":
        return slot.channel === channel;
      case "closing":
      case "quarantined":
        return false;
    }
  }

  // Delivered on the run's own binding; a run the routes hold no binding for is recorded, since
  // nothing could attribute its end.
  #reportSupersededRun(sessionId: SessionId, runId: RunId): void {
    const bindingId = this.#dependencies.runRoutes.bindingIdFor(runId);
    if (bindingId === undefined) {
      this.#dependencies.diagnostics.emit({
        provider: "claude",
        kind: "superseded_run_report_failed",
        rawWireType: null,
        dispositionReason: "the superseded run holds no binding its end could be attributed on",
        details: { sessionId, runId, providerFailureDetail: CLAUDE_SUPERSEDED_RUN_DETAIL },
      });
      return;
    }
    void this.#dependencies.dispatch.send(
      {
        kind: "run_lifecycle",
        bindingId,
        change: {
          runId,
          newState: "failed",
          failureCategory: "provider failure",
          recoveryCondition: "recovery-needed",
          providerFailureDetail: CLAUDE_SUPERSEDED_RUN_DETAIL,
        },
      },
      null,
    );
  }
}
