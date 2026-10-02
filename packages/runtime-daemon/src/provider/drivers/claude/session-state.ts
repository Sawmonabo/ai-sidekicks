/**
 * The lifecycle's dependencies and the per-session state it keeps: the live session, its
 * routing band, the slot it occupies, and the frame router configuration.
 */

import { type ExecutionPosture, type RunId, type SessionId } from "@ai-sidekicks/contracts";
import { type CompactionWaitScheduler } from "../../compaction-wait.js";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import {
  ThreadFrameRouter,
  type RoutableProviderFrame,
  type SubagentLifecycleEmission,
  type ThreadFrameRoute,
  type ThreadFrameRouterConfig,
} from "../../thread-frame-router.js";
import {
  UsageDeltaAccountant,
  type CumulativeAxisReadings,
  type MeteredUsageDelta,
} from "../../usage-delta-accountant.js";
import {
  type TextNeutralityMechanismGrade,
  type TextNeutralizationRunFailure,
} from "../../outbound-frame.js";
import type {
  ClaudeHandshakeDeclaration,
  ClaudeInboundFrameObservation,
  ClaudeRunDispatchResolver,
  ClaudeProviderProcess,
  ClaudeSessionTransport,
  ClaudeSpawnBoundLegs,
} from "./session-transport.js";

/**
 * One provider session's `system/init` declaration, stamped with the provider session id it was
 * observed under. A rewind forks a new process behind the same `SessionId`, so reads check the
 * stamp and answer as unobserved rather than with the dead process's declaration.
 */
export interface ClaudeHeldHandshake {
  readonly providerSessionId: string;
  readonly declaration: ClaudeHandshakeDeclaration;
  /** Command names invocable over the programmatic transport: `slash_commands` only, uncapped. */
  readonly invocableCommandNames: ReadonlySet<string>;
}

/** A session's router and accountant, held together so no frame routes to an unmetered thread. */
export interface ClaudeSessionRoutingBand {
  readonly router: ThreadFrameRouter<ClaudeRoutableFrame>;
  readonly accountant: UsageDeltaAccountant;
}

/** What a session's process was spawned with, kept so a later run can be checked against it. */
export interface ClaudeSpawnBinding {
  // The complete posture, so every axis can be compared.
  readonly executionPosture: ExecutionPosture | undefined;
  readonly outputSchemaDigest: string | undefined;
}

/** A session whose provider process is running, with the legs it was spawned with. */
export interface LiveClaudeSession {
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly channel: ClaudeProviderProcess;
  readonly spawnBinding: ClaudeSpawnBinding;
  /**
   * The legs this process was spawned with. A rewind respawns from these; re-deriving would guess,
   * and a guess that omits the posture relaunches the session unsandboxed.
   */
  readonly spawnBoundLegs: ClaudeSpawnBoundLegs;
  /**
   * Usage base: zero for `fresh`, else the prior-emitted cumulative sum for `resume`, which after
   * a rewind is keyed by the predecessor's id because the fork announces a new one.
   */
  readonly establishment: ClaudeUsageEstablishment;
  /**
   * The provider account the daemon admitted this process against, or `null` when none was named.
   * Held opaque and captured at establishment because the live registry can move; a rewind
   * inherits it. See {@link ClaudeSessionLifecycleDependencies.readBoundProviderAccountId}.
   */
  readonly admittedProviderAccountId: string | null;
}

/** Usage base-establishment arm; the resume arm must name the thread whose sum it bases on. */
export type ClaudeUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

/**
 * One canonical session's slot state. Absence from `#sessionSlots` is EMPTY, the only state where
 * a create or resume may proceed. One registry holds every state so a slot mid-disposal never
 * reads as EMPTY. Arms with an in-flight transition carry a `settled` promise that never rejects.
 */
export type ClaudeSessionSlot =
  // A create, resume or rewind is bringing a process up. Ends live, or EMPTY on failure.
  // `channel` is the predecessor's on a rewind, so its frames stay attributable during the fork.
  | {
      readonly state: "establishing";
      readonly settled: Promise<void>;
      readonly channel: ClaudeProviderProcess | undefined;
    }
  // A process is up and may accept runs. The only startable state.
  | { readonly state: "live"; readonly session: LiveClaudeSession }
  // `dispose` is in flight. Ends EMPTY on resolve, QUARANTINED on reject.
  | { readonly state: "closing"; readonly settled: Promise<void> }
  // `dispose` rejected: the process is still alive and this channel is the only handle anyone
  // holds on it. Retained until a later close disposes it.
  | { readonly state: "quarantined"; readonly channel: ClaudeProviderProcess };

/**
 * Whether the provider-account member is present but empty, a wiring fault the caller refuses
 * (create throws, resume returns `failed`). Folding it to `null` would hide it; carrying it would
 * let two accountless bindings compare equal.
 */
export function isUnusableAdmittedProviderAccountId(requested: string | undefined): boolean {
  return requested !== undefined && requested.length === 0;
}

/** The provider account id a session declares, or null when none was requested. */
export function readAdmittedProviderAccountId(requested: string | undefined): string | null {
  return requested ?? null;
}

/** What a Claude session lifecycle needs from the daemon: the transport, sinks and id sources. */
export interface ClaudeSessionLifecycleDependencies {
  readonly transport: ClaudeSessionTransport;
  readonly runDispatchResolver: ClaudeRunDispatchResolver;
  /** The daemon-wide diagnostic band; required, since each fail-closed path owes a record. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * The daemon's prior-emitted cumulative token sums under `threadId`, which on a rewind is the
   * predecessor. `undefined` bases at zero; an unbound or throwing reader is recorded as a fault.
   */
  readonly readPriorEmittedUsage?:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  /** Receives each metered usage delta; the emission pipeline mints `usage_telemetry`. */
  readonly onMeteredUsage?: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  /** Text-neutrality grade (default `emulated`), injectable for a `native` upgrade. */
  readonly textNeutralityMechanismGrade?: TextNeutralityMechanismGrade | undefined;
  /** Correlation minting for outbound text frames. Injectable for tests. */
  readonly mintOutboundFrameCorrelationId?: (() => string) | undefined;
  /**
   * Receives the run terminal a text-neutralization trip produces. Required: a trip raises no
   * JSON-RPC error, so without it a neutralized turn ends with no terminal the person can read.
   */
  readonly onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  /** Receives each child's `subagent.started`/`subagent.completed` pair, its only timeline mark. */
  readonly onSubagentLifecycle?:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  /**
   * Receives the routing decision for a frame released from a hold, when no observer call can
   * answer for it. Only `carve-out-usage` and `suppress-child-transcript` occur; interactive
   * requests are connection-scoped and never held.
   */
  readonly onReleasedFrameRoute?:
    | ((
        sessionId: SessionId,
        observation: ClaudeInboundFrameObservation,
        route: ThreadFrameRoute,
      ) => void)
    | undefined;
  // The provider session id pinned at spawn (`--session-id`); the CLI accepts any valid UUID.
  readonly mintProviderSessionId?: (() => string) | undefined;
  // The opaque session-binding handle the `resumed` arm carries; the default needs no database.
  readonly mintBindingId?: (() => string) | undefined;
  /** Schedules the compaction bound; an unref'd timer by default, injectable to skip the wait. */
  readonly compactionWaitScheduler?: CompactionWaitScheduler | undefined;
  /**
   * The daemon account registry's answer, cross-checking the account captured at establishment:
   * the record wins over a silent port, differing accounts refuse the call, and `null` is stamped
   * when neither names one (the routing check treats `null` as matching nothing).
   */
  readonly readBoundProviderAccountId?: ((sessionId: SessionId) => string | null) | undefined;
}

/**
 * One observed Claude frame as the thread-frame router sees it. Claude frames carry no thread id,
 * so `threadId` is the subagent identity or else the provider session id; never `null`, which
 * would quarantine every ordinary frame.
 */
export interface ClaudeRoutableFrame extends RoutableProviderFrame {
  readonly threadId: string;
  /** The observation this frame was built from, so a released hold can still be metered. */
  readonly observation: ClaudeInboundFrameObservation;
}

/**
 * The router's bounds. The hold covers a subagent's frames arriving ahead of its `SubagentStart`;
 * the short timeout means a frame held longer names a child never announced.
 */
export const CLAUDE_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});
