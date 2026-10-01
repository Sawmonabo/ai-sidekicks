// The Claude driver's session and run lifecycle: `createSession`, `resumeSession`, `startRun`,
// `interruptRun` and `closeSession`, over one slot per session. The establishment legs, the
// text-neutralization tripwire, frame routing, the handshake register, the spawn legs and
// compaction dispatch are collaborators this class builds once; the other driver operations live
// in sibling modules.
//
// Provider-process concerns sit behind the injected `ClaudeSessionTransport` and
// `ClaudeSessionChannel` ports: this module spawns nothing and reads no environment variable, so
// it cannot leak a `CLAUDE_CODE_OAUTH_TOKEN`. Errors here carry a registered `driver.*` code.

import {
  type DriverCompactionResult,
  type InterruptRunParams,
  type ProviderCommandListResult,
  type ProviderOutputSpeedState,
  type RunId,
  type SessionId,
} from "@ai-sidekicks/contracts";
import { PendingCompactionRegistry } from "../../compaction-wait.js";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import { ThreadFrameRouter, type ThreadFrameRoute } from "../../thread-frame-router.js";
import { UsageDeltaAccountant } from "../../usage-delta-accountant.js";
import {
  classifyProviderRequestFailure,
  mayReattemptAfterDefinitelyUnsent,
} from "../../transcript/failure-mapping.js";
import {
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  RuntimeBindingQuarantine,
} from "../../outbound-frame.js";
import { ClaudeTerminalEmissionGate } from "./turn-evidence.js";
import { mintUuidV7 } from "../../../ids/uuid-v7.js";
import {
  CLAUDE_COMPACTION_COMMAND_NAME,
  ClaudeControlRequestRefusedError,
  type ClaudeRunChannelLookup,
  type ClaudeRunDispatchResolver,
  type ClaudeSessionChannel,
  type ClaudeSessionTransport,
  composeClaudeMandatedEnvironment,
  disposeSubagentAdmission,
  observeClaudeUserTextFailure,
} from "./session-transport.js";
import {
  CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
  type ClaudeRoutableFrame,
  type ClaudeSessionLifecycleDependencies,
  type ClaudeSessionRoutingBand,
  type ClaudeSessionSlot,
  type LiveClaudeSession,
} from "./session-state.js";
import {
  buildAuthProbeResult,
  CLAUDE_AUTH_PROBE_REACHED_DETAIL,
  ClaudeAuthenticationRequiredError,
  ClaudeSessionUnavailableError,
  describeFailure,
} from "./session-errors.js";
import { assertClaudeSpawnBoundRealization, ClaudeSpawnLegComposer } from "./spawn-legs.js";
import { ClaudeRunRoutes } from "./run-routes.js";
import { ClaudeHandshakeRegister } from "./handshake-register.js";
import { ClaudeFrameRouting } from "./frame-routing.js";
import { attemptClaudeFrameWrite, ClaudeTextNeutralization } from "./text-neutralization.js";
import { buildClaudeResumeFailure, ClaudeSessionEstablishment } from "./session-establishment.js";
import { ClaudeCompactionDispatch } from "./compaction-dispatch.js";
import type {
  CloseSessionParams,
  CompactContextParams,
  CreateSessionParams,
  DriverAuthProbeResult,
  DriverResumeResult,
  ForkConversationResult,
  ListProviderCommandsParams,
  ProviderSessionHandle,
  ResumeSessionParams,
  ForkConversationParams,
  StartRunParams,
} from "../../provider-driver.js";

/** Drives Claude sessions over a `ClaudeSessionTransport`, with per-session slot and metering. */
export class ClaudeSessionLifecycle implements ClaudeRunChannelLookup {
  readonly #transport: ClaudeSessionTransport;
  readonly #runDispatchResolver: ClaudeRunDispatchResolver;
  // Every session's slot. Create and resume refuse on a non-EMPTY slot instead of chaining, since
  // a session realized under another posture is what `assertClaudeSpawnBoundRealization`
  // prevents; close chains. Claims read and write with no await between, so check-then-act is
  // atomic.
  readonly #sessionSlots: Map<SessionId, ClaudeSessionSlot> = new Map();
  readonly #runRoutes: ClaudeRunRoutes = new ClaudeRunRoutes();
  // The producer half of the intended-close signal, signaled at the top of `closeSession` and
  // consumed at the terminal-emission boundary in `event-normalizer.ts`. Keyed beside the slot map
  // because the intent must be recordable while the slot holds no live session.
  readonly #terminalEmissionGates: Map<SessionId, ClaudeTerminalEmissionGate> = new Map();
  // A session's router and accountant, in one map so they are created and released together.
  readonly #routingBands: Map<SessionId, ClaudeSessionRoutingBand> = new Map();
  // The tripwire correlates each frame with the turn that settles it; the quarantine holds
  // bindings a trip disposed.
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine: RuntimeBindingQuarantine = new RuntimeBindingQuarantine();
  readonly #handshakes: ClaudeHandshakeRegister;
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #frameRouting: ClaudeFrameRouting;
  readonly #textNeutralization: ClaudeTextNeutralization;
  readonly #establishment: ClaudeSessionEstablishment;
  readonly #compactionDispatch: ClaudeCompactionDispatch;

  constructor(dependencies: ClaudeSessionLifecycleDependencies) {
    this.#transport = dependencies.transport;
    this.#runDispatchResolver = dependencies.runDispatchResolver;
    this.#diagnostics = dependencies.diagnostics;
    this.#handshakes = new ClaudeHandshakeRegister(dependencies);
    this.#pendingCompactions = new PendingCompactionRegistry(
      dependencies.compactionWaitScheduler ??
        ((callback: () => void, delayMs: number): (() => void) => {
          const timer = setTimeout(callback, delayMs);
          // Unref'd so a pending wait never keeps the daemon alive; shutdown is a binding loss.
          timer.unref();
          return (): void => {
            clearTimeout(timer);
          };
        }),
    );
    // Composes all provider-bound text; handed to the collaborators that write it.
    const outboundTextFrameWriter = new OutboundTextFrameWriter({
      // `emulated` at the pinned build: its input intercepts command-shaped text (measured).
      mechanismGrade: dependencies.textNeutralityMechanismGrade ?? "emulated",
      mintCorrelationId: dependencies.mintOutboundFrameCorrelationId,
    });
    // Built here because the predicate reads a field declared later. A session is retired when it
    // holds no slot or a trip quarantined it; the slot map is checked, not `#findLiveSession`,
    // since a session mid-establishment or mid-close may still have frames to rule.
    this.#outboundFrameTripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey: string): boolean =>
        !this.#sessionSlots.has(scopeKey as SessionId) ||
        this.#runtimeBindingQuarantine.isSessionDisposed(scopeKey),
    });
    this.#frameRouting = new ClaudeFrameRouting({
      ...dependencies,
      pendingCompactions: this.#pendingCompactions,
      handshakes: this.#handshakes,
    });
    this.#textNeutralization = new ClaudeTextNeutralization({
      ...dependencies,
      outboundTextFrameWriter,
      outboundFrameTripwire: this.#outboundFrameTripwire,
      runtimeBindingQuarantine: this.#runtimeBindingQuarantine,
      runRoutes: this.#runRoutes,
      disposeQuarantinedSession: (sessionId: SessionId): void => {
        this.#disposeQuarantinedSession(sessionId);
      },
    });
    this.#compactionDispatch = new ClaudeCompactionDispatch({
      pendingCompactions: this.#pendingCompactions,
      outboundTextFrameWriter,
      diagnostics: dependencies.diagnostics,
    });
    this.#establishment = new ClaudeSessionEstablishment({
      transport: dependencies.transport,
      mintProviderSessionId: dependencies.mintProviderSessionId ?? mintUuidV7,
      mintBindingId: dependencies.mintBindingId ?? mintUuidV7,
      spawnLegs: new ClaudeSpawnLegComposer(dependencies),
      registerLiveSession: (live: LiveClaudeSession): void => {
        this.#registerLiveSession(live);
      },
      releaseSupersededPredecessor: (
        sessionId: SessionId,
        predecessor: LiveClaudeSession,
      ): void => {
        this.#releaseSupersededPredecessor(sessionId, predecessor);
      },
    });
  }

  /**
   * Spawns a new provider process for `params.sessionId` and registers it. Throws
   * `ClaudeSessionUnavailableError` when the slot is held or the provider account is empty;
   * throwing is the only failure channel.
   */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Fail closed, not replace: an existing channel has its own posture, cap and schema.
    const slotHolder = this.#describeSlotHolder(params.sessionId);
    if (slotHolder !== undefined) {
      throw new ClaudeSessionUnavailableError("session_already_live", {
        sessionId: params.sessionId,
        detail: slotHolder,
      });
    }

    return await this.#withSessionSlotClaimed(
      params.sessionId,
      async () => await this.#establishment.establishCreatedSession(params),
    );
  }

  /** Resumes a provider session by its handle; every failure returns through the `failed` arm. */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Resuming beside a live channel would leave two processes for one canonical session, and an
    // in-flight establishment belongs to a caller with different spawn-bound legs.
    const slotHolder = this.#describeSlotHolder(params.sessionId);
    if (slotHolder !== undefined) {
      return buildClaudeResumeFailure(
        "recovery-needed",
        `${slotHolder} Resuming beside it would replace it silently.`,
      );
    }

    return await this.#withSessionSlotClaimed(
      params.sessionId,
      async () => await this.#establishment.establishResumedSession(params),
    );
  }

  async startRun(params: StartRunParams): Promise<void> {
    const dispatch = await this.#runDispatchResolver.resolveRunDispatch(params);
    if (dispatch === undefined) {
      throw new ClaudeSessionUnavailableError("run_dispatch_unresolved", { runId: params.runId });
    }

    // Before the live-session lookup so the cause survives: a trip disposes the channel, and the
    // lookup would then report `no_live_session`, which invites a retry into the process that
    // swallowed the user's words. A fresh spawn releases the quarantine.
    this.#runtimeBindingQuarantine.assertSessionAttachable(dispatch.sessionId);

    const live = this.#findLiveSession(dispatch.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    assertClaudeSpawnBoundRealization(params, live);

    // One pending opening frame per run key: a second would be ruled `UNRECOGNIZED_TURN_EVIDENCE`
    // and trip the session. Not keyed on the run route, which a dead-channel ruling keeps while
    // the run may re-dispatch.
    if (this.#outboundFrameTripwire.hasPendingFrame(params.runId)) {
      throw new ClaudeSessionUnavailableError("run_already_dispatched", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    // Claude's settling envelope carries no run id, so a terminal's classification can be credited
    // to only one run per session. Refused before anything is composed, so the caller may
    // re-dispatch once the turn settles.
    if (this.#outboundFrameTripwire.hasPendingFrameInScope(dispatch.sessionId)) {
      throw new ClaudeSessionUnavailableError("session_turn_in_flight", {
        sessionId: dispatch.sessionId,
        runId: params.runId,
      });
    }

    // Only a definitely-unsent write is retried; the shared classifier decides, as for Codex.
    for (let dispatchAttemptsMade = 1; ; dispatchAttemptsMade += 1) {
      const frame = this.#textNeutralization.registerOpeningDispatch(dispatch, params);
      const attempt = await attemptClaudeFrameWrite(live.channel, frame);
      if (attempt.settled === "written") {
        return;
      }
      // Ruled before the retry decision: the ruling releases the frame's registration, and a
      // second registered frame on one run key would trip the tripwire.
      this.#textNeutralization.ruleFailedOpeningFrame({
        sessionId: dispatch.sessionId,
        runId: params.runId,
        channel: live.channel,
        frame,
        delivery: attempt.delivery,
      });
      const disposition = classifyProviderRequestFailure(
        observeClaudeUserTextFailure(attempt.delivery),
      ).disposition;
      // Only `unsent` is re-sent, as the one positive claim that the provider saw nothing.
      // `reconcile-ambiguous-delivery` has no readback here, so the turn fails instead.
      if (
        disposition !== "retry-definitely-unsent" ||
        !mayReattemptAfterDefinitelyUnsent(dispatchAttemptsMade)
      ) {
        throw attempt.cause;
      }
    }
  }

  /**
   * Zero-turn authentication probe; never throws. `ClaudeAuthenticationRequiredError` is
   * `unauthenticated`, any other throw `indeterminate`. It claims no session slot.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    try {
      // Carries the mandated environment like every other spawn, so the probe cannot update the
      // installation underneath the readings.
      const reading = await this.#transport.probeAuth({
        mandatedEnvironment: composeClaudeMandatedEnvironment(),
      });
      return buildAuthProbeResult(
        "authenticated",
        reading.detail ?? CLAUDE_AUTH_PROBE_REACHED_DETAIL,
      );
    } catch (cause) {
      // Typed, not sniffed from the message, which provider rewording would break.
      return buildAuthProbeResult(
        cause instanceof ClaudeAuthenticationRequiredError ? "unauthenticated" : "indeterminate",
        describeFailure(cause),
      );
    }
  }

  /**
   * Sends the CLI's `interrupt` control request for the run's channel. Throws
   * `ClaudeSessionUnavailableError` when the run has no live channel and
   * `ClaudeControlRequestRefusedError` when the CLI refuses.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const channel = this.findChannelForRun(params.runId);
    if (channel === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId: params.runId });
    }
    // `params.reason` is not forwarded: the pinned CLI's `interrupt` request has no reason member.
    // A refusal throws, since returning would claim an interrupt that did not happen.
    const response = await channel.sendControlRequest({
      subtype: "interrupt",
      cancelQueued: false,
    });
    if (response.subtype === "error") {
      throw new ClaudeControlRequestRefusedError("interrupt", response.error);
    }
  }

  /**
   * Forks the provider conversation at a recorded message, leaving the original and the files on
   * disk untouched (`--rewind-files` covers only Write/Edit). An `applied` result carries a fresh
   * `bindingId` for the new provider session; a failed rewind restores the predecessor.
   */
  async forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      // Thrown, not degraded: `degraded` is for a driver that could act and reported a fallback.
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }
    return await this.#withRewindSlotClaimed(
      params.sessionId,
      live,
      async () => await this.#establishment.establishRewoundSession(params, live),
    );
  }

  /**
   * Triggers a context compaction by sending the provider's `/compact` as a `driver_command`
   * frame. Refuses `command_absent` unless the binding lists the command, since that origin skips
   * the tripwire; `applied` needs the typed compaction frame. Throws with no live session.
   */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }

    // The held enumeration, matched by stamp: stricter than the composed entries'
    // `(driverName, providerAccountId)` pair, which would refuse every accountless session.
    const held = this.#handshakes.heldHandshakeFor(params.sessionId, live.providerSessionId);
    if (held === undefined || !held.invocableCommandNames.has(CLAUDE_COMPACTION_COMMAND_NAME)) {
      // No prompt-based fallback: a model summary spends a turn and produces no boundary.
      return { status: "refused", reason: "command_absent" };
    }

    return await this.#compactionDispatch.dispatchCompaction(params.sessionId, live.channel);
  }

  /**
   * Enumerates the provider's command and skill surface for one binding from the held handshake,
   * with terminal slash commands carried as `scope: "terminal"`. The cap trims this reply only
   * (`complete: false` plus a diagnostic); before the handshake it answers empty and complete.
   */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    const live = this.#findLiveSession(params.sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", {
        sessionId: params.sessionId,
      });
    }
    const enumeration = this.#handshakes.enumerateProviderCommands(params.sessionId, live);
    return await Promise.resolve({
      bindings: [{ runId: this.#runRoutes.soleLiveRunOn(params.sessionId), ...enumeration }],
    });
  }

  /**
   * The output-speed state the provider declared, or `undefined` before it has: the handshake rides
   * a turn-bearing exchange that create and resume do not wait for. A declaration the contract's
   * bounds reject reads as absent, with a diagnostic; `cooldown` is carried as declared.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    const live = this.#findLiveSession(sessionId);
    if (live === undefined) {
      return undefined;
    }
    return this.#handshakes.observedOutputSpeedFor(sessionId, live.providerSessionId);
  }

  /**
   * Closes the session's channel, chaining behind any in-flight transition and retrying a
   * quarantined channel. Idempotent; rejects if the process will not exit.
   */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Latch first, so every terminal from here, including an in-flight establishment's, is a clean
    // shutdown.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();

    // Chains on any in-flight transition and re-reads: the slot may settle as live, empty or
    // quarantined.
    for (;;) {
      const slot = this.#sessionSlots.get(params.sessionId);
      // Idempotent: a double close is normal teardown; the latch set above goes so gates do not
      // pile up.
      if (slot === undefined) {
        this.#terminalEmissionGates.delete(params.sessionId);
        return;
      }
      // Exhaustive: a new slot state must decide whether close chains on it or acts on it.
      switch (slot.state) {
        case "establishing":
        case "closing":
          await slot.settled;
          continue;
        case "live":
          // Settled and occupied, so this call acts; everything up to the CLOSING write in
          // `#disposeHeldChannel` is synchronous, so no second closer sees this state.
          // Routes first: a route into a dying process would aim a later interrupt at a dead run.
          this.#runRoutes.retireRunRoutes(params.sessionId);
          // Not in `retireRunRoutes`: its terminal-path caller has just ruled the tripwire.
          this.#outboundFrameTripwire.forgetScope(params.sessionId);
          // Before the await, like the routes: a subagent would wait on a slot in a dying process.
          disposeSubagentAdmission(slot.session.spawnBoundLegs);
          await this.#disposeHeldChannel(params.sessionId, slot.session.channel);
          return;
        case "quarantined":
          // Retry the retained channel, the only handle on a process that would not exit.
          await this.#disposeHeldChannel(params.sessionId, slot.channel);
          return;
      }
    }
  }

  // Holds the slot as CLOSING for the whole await, so it never reads EMPTY while a process is dying
  // and a concurrent create cannot spawn a replacement beside it.
  async #disposeHeldChannel(sessionId: SessionId, channel: ClaudeSessionChannel): Promise<void> {
    let markSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#sessionSlots.set(sessionId, { state: "closing", settled });
    // Pushed at the CLOSING write, before the await, so a waiting caller learns now; every close
    // path funnels through here.
    this.#pendingCompactions.releaseBinding(sessionId);
    try {
      await channel.dispose("session_closed");
      // CLOSING -> EMPTY.
      this.#sessionSlots.delete(sessionId);
      // The gate dies with its session; a later terminal names a run no slot can settle.
      this.#terminalEmissionGates.delete(sessionId);
      // Per-session routing state; a surviving router would answer the next session with a stale
      // thread registry.
      this.#routingBands.delete(sessionId);
      // A live read of a process that no longer exists; keeping it would be a stale registry.
      this.#handshakes.forgetHandshake(sessionId);
    } catch (error) {
      // CLOSING -> QUARANTINED: nothing else references the still-running process, so keep the
      // channel.
      this.#sessionSlots.set(sessionId, { state: "quarantined", channel });
      throw error;
    } finally {
      // After the state write on both paths, so a chainer resuming here sees the settled state.
      markSettled();
    }
  }

  /**
   * The live channel a run is bound to, or `undefined` when it has none yet. Throws if a tripwire
   * trip disposed the run's binding.
   */
  findChannelForRun(runId: RunId): ClaudeSessionChannel | undefined {
    // Refused, not `undefined`, which would read as "no channel yet" and invite a retry into the
    // same swallow; the refusal carries the run terminal's code.
    this.#runtimeBindingQuarantine.assertRunAttachable(runId);
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.#findLiveSession(sessionId)?.channel;
  }

  /**
   * The terminal-emission gate for one session, read live at each terminal because a gate captured
   * before a close would miss the latch the close sets.
   */
  terminalEmissionGateFor(sessionId: SessionId): ClaudeTerminalEmissionGate {
    return this.#intendedCloseGateFor(sessionId);
  }

  /**
   * The thread-frame router for one session, or `undefined` when it holds no routing band.
   * Non-creating: a get-or-create accessor would let a call after close resurrect a band.
   */
  frameRouterFor(sessionId: SessionId): ThreadFrameRouter<ClaudeRoutableFrame> | undefined {
    return this.#routingBands.get(sessionId)?.router;
  }

  /** The usage-delta accountant for one session, or `undefined` when it holds no routing band. */
  usageAccountantFor(sessionId: SessionId): UsageDeltaAccountant | undefined {
    return this.#routingBands.get(sessionId)?.accountant;
  }

  // Builds the session's routing band if it holds none; reached only from `#registerLiveSession`.
  #ensureRoutingBand(sessionId: SessionId): ClaudeSessionRoutingBand {
    const existing = this.#routingBands.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const band: ClaudeSessionRoutingBand = {
      router: new ThreadFrameRouter<ClaudeRoutableFrame>({
        provider: "claude",
        diagnostics: this.#diagnostics,
        config: CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
      }),
      accountant: new UsageDeltaAccountant({
        provider: "claude",
        diagnostics: this.#diagnostics,
      }),
    };
    this.#routingBands.set(sessionId, band);
    return band;
  }

  // Get-or-create, so the intent latch survives whichever of close and establishment reaches the
  // session first.
  #intendedCloseGateFor(sessionId: SessionId): ClaudeTerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new ClaudeTerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
  }

  // Only a live slot yields a session: no run may start in a process that is coming up, going down
  // or refusing to die.
  #findLiveSession(sessionId: SessionId): LiveClaudeSession | undefined {
    const slot = this.#sessionSlots.get(sessionId);
    return slot?.state === "live" ? slot.session : undefined;
  }

  #registerLiveSession(live: LiveClaudeSession): void {
    // Band, then slot, then listeners: listener registration can deliver a frame re-entrantly,
    // which needs a band to hold it and a slot for the identity gate to accept the adopted channel.
    // The previous slot is restored if a listener registration throws.
    const previousSlot = this.#sessionSlots.get(live.sessionId);
    const bandExistedBefore = this.#routingBands.has(live.sessionId);
    const band = this.#ensureRoutingBand(live.sessionId);
    this.#sessionSlots.set(live.sessionId, { state: "live", session: live });
    // Discarded where all establishment paths converge, before listeners register: a resume reuses
    // its predecessor's `providerSessionId`, so a surviving record would match. Fail-closed (none
    // survives today); not restored on rollback, since a failed adoption already disposed its
    // source.
    this.#handshakes.forgetHandshake(live.sessionId);
    try {
      this.#registerLiveSessionHooks(band, live);
    } catch (error) {
      // Restores rather than deletes: the previous value is the caller's `establishing` claim, and
      // deleting it would publish an EMPTY slot a rewind could not recognize.
      if (previousSlot === undefined) {
        this.#sessionSlots.delete(live.sessionId);
      } else {
        this.#sessionSlots.set(live.sessionId, previousSlot);
      }
      // Only a band this call created is released: a rewind's successor joins the predecessor's
      // band, and dropping it would zero registers about to be restored.
      if (!bandExistedBefore) {
        this.#routingBands.delete(live.sessionId);
      }
      throw error;
    }
    // Only after a successful registration, so a failed adoption cannot lift a refusal it never
    // replaced (the quarantine names a binding; a fresh channel now answers for this id).
    this.#runtimeBindingQuarantine.releaseSession(live.sessionId);
  }

  // The listener half of registration, separated so the slot rollback has one thing to guard.
  #registerLiveSessionHooks(band: ClaudeSessionRoutingBand, live: LiveClaudeSession): void {
    // Claude serializes turns per session, so the route pointing at this session is the run that
    // just ended. Only routes retire, never the slot.
    const retireOnTurnTerminal = (terminalFrame: unknown): void => {
      // Identity-gated: a disposed, quarantined or replaced channel can still fire (the driver
      // holds no kill), and an ungated listener would retire the routes of the slot's current
      // session. This also makes the listener a no-op during CLOSING.
      if (this.#findLiveSession(live.sessionId)?.channel !== live.channel) {
        return;
      }
      // Ruled before retirement: the tripwire is keyed by run id, and retirement empties the map
      // those ids come from.
      this.#textNeutralization.ruleTextNeutralizationTripwire(live.sessionId, terminalFrame);
      this.#runRoutes.retireRunRoutes(live.sessionId);
    };
    live.channel.onTurnTerminal(retireOnTurnTerminal);
    // Identity-gated the same way, and fail-closed: a frame from a channel the daemon no longer
    // owns must not project.
    live.channel.onInboundFrame((observation): ThreadFrameRoute => {
      if (!this.#isChannelCurrentlyBound(live.sessionId, live.channel)) {
        return {
          decision: "quarantined",
          reason:
            "frame arrived on a channel this session no longer holds; refused rather than projected into whichever session occupies the slot now",
        };
      }
      const boundBand = this.#routingBands.get(live.sessionId);
      if (boundBand === undefined) {
        // Unreachable: the band is built before this listener exists and only a close releases it;
        // kept fail-closed rather than project a frame no router classified.
        return {
          decision: "quarantined",
          reason:
            "frame arrived while this session held no routing band; refused rather than classified against a registry that does not exist",
        };
      }
      return this.#frameRouting.observeInboundFrame(
        boundBand,
        live.sessionId,
        live.providerSessionId,
        observation,
      );
    });
    // Base registers and the session's own thread identity, before any frame can be metered.
    this.#frameRouting.bindSessionThread(
      band,
      live.sessionId,
      live.providerSessionId,
      live.establishment,
    );
    // Through the accessor `closeSession` uses, so a close signaled during establishment finds its
    // latch.
    this.#intendedCloseGateFor(live.sessionId);
  }

  /**
   * Whether this channel is bound to this session in any state the session can continue from.
   * Wider than `#findLiveSession`, for frame routing only: a rewind holds an `establishing` slot
   * while the predecessor keeps emitting, and refusing those frames would leave a transcript hole.
   */
  #isChannelCurrentlyBound(sessionId: SessionId, channel: ClaudeSessionChannel): boolean {
    const slot = this.#sessionSlots.get(sessionId);
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

  // Names the current holder of a session slot for a refusal detail, or `undefined` when the slot
  // is free. One predicate, so the two entry points agree on what "taken" means.
  #describeSlotHolder(sessionId: SessionId): string | undefined {
    const slot = this.#sessionSlots.get(sessionId);
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
        return `The Claude process for session ${sessionId} refused to exit and is quarantined pending a successful close;`;
    }
  }

  // Claims the slot synchronously, before `establish` is awaited, so no caller sees a free slot
  // while it spawns; releases the claim however it settles.
  async #withSessionSlotClaimed<TEstablished>(
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
    this.#sessionSlots.set(sessionId, { state: "establishing", settled, channel: undefined });
    try {
      return await establishment;
    } finally {
      // A successful establishment has already overwritten the slot; only a failed one is cleared,
      // and only if the claim is ours.
      const slot = this.#sessionSlots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#sessionSlots.delete(sessionId);
      }
    }
  }

  /**
   * Claims a live slot for a rewind and restores the predecessor if it installs no successor.
   * Unlike `#withSessionSlotClaimed` it must not clear on failure: a rewind starts from live, and
   * an EMPTY slot for a running process would let the next create spawn a second one.
   */
  async #withRewindSlotClaimed(
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
    rewind: () => Promise<ForkConversationResult>,
  ): Promise<ForkConversationResult> {
    const rewinding = rewind();
    const settled = rewinding.then(
      () => undefined,
      () => undefined,
    );
    // The predecessor's channel stays bound: its process is still up and emitting frames that
    // belong to this session's transcript.
    this.#sessionSlots.set(sessionId, {
      state: "establishing",
      settled,
      channel: predecessor.channel,
    });
    try {
      return await rewinding;
    } finally {
      // Identity-checked, so a successful rewind or a concurrent close is left alone.
      const slot = this.#sessionSlots.get(sessionId);
      if (slot?.state === "establishing" && slot.settled === settled) {
        this.#sessionSlots.set(sessionId, { state: "live", session: predecessor });
      }
    }
  }

  /**
   * Tears down the channel a tripwire trip condemned, through `#disposeHeldChannel`. Detached: the
   * only caller is a channel's synchronous terminal listener, which must not wait on a child's
   * death; the refusal still holds, since the quarantine entry is installed first.
   */
  #disposeQuarantinedSession(sessionId: SessionId): void {
    // Outside the liveness read: the frames are owed an answer whether or not a channel is left.
    this.#textNeutralization.ruleAbandonedFramesFailClosed(sessionId);
    const live = this.#findLiveSession(sessionId);
    if (live === undefined) {
      return;
    }
    void this.#disposeHeldChannel(sessionId, live.channel).catch(() => {
      // Recorded there: a rejected dispose has already moved the slot to `quarantined` with the
      // channel retained for a later close. Rethrowing would be an unhandled rejection out of a
      // terminal listener.
    });
  }

  /**
   * Releases a rewound predecessor once its successor is adopted, before its channel is disposed.
   * The sweep runs before route retirement, which empties the run routes. Frames fail rather than
   * drop, so an undelivered run never looks delivered.
   */
  #releaseSupersededPredecessor(sessionId: SessionId, predecessor: LiveClaudeSession): void {
    this.#textNeutralization.failSupersededDeliveries(sessionId);
    this.#runRoutes.retireRunRoutes(sessionId);
    // Usually a no-op (the sweep consumed the registrations); the only budget release here.
    this.#outboundFrameTripwire.forgetScope(sessionId);

    // Released after the successor is installed, so every earlier failure path is non-destructive.
    // A disposal failure does not fail the fork.
    disposeSubagentAdmission(predecessor.spawnBoundLegs);
    // The predecessor is going away, so its armed compaction waits can never see their evidence.
    // None exist for the successor: this method holds the rewind slot claim, and `compactContext`
    // needs a settled live slot.
    this.#pendingCompactions.releaseBinding(sessionId);
  }
}
