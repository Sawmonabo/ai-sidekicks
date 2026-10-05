// The establishment legs of a Claude session: spawning a fresh process, resuming one by its handle,
// and forking one at a recorded message. Each leg attaches a channel, gates its identity, and
// either registers it with the lifecycle or disposes it.
//
// A resume must never silently replace the provider session under the same canonical run:
// - `DriverResumeResult`'s `failed` arm carries no `bindingId`, so failed and resumed cannot mix.
// - It counts as `resumed` only when the transport reports the session id the handle names
//   (Claude starts a fresh session when the recorded working directory changed).
// - Every refused attachment is disposed before `failed` is returned.

import type { RecoveryCondition } from "@ai-sidekicks/contracts/provider-driver-recovery";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import { applyClaudeOutputSpeed } from "./output-speed.js";
import type {
  ClaudeChannelDisposalReason,
  ClaudeFastModeDeclaration,
  ClaudeResumedSessionAttachment,
  ClaudeProviderProcess,
  ClaudeSessionTransport,
  ClaudeSpawnBoundLegs,
} from "./session-transport.js";
import {
  isUnusableAdmittedProviderAccountId,
  type LiveClaudeSession,
  readAdmittedProviderAccountId,
} from "./session-state.js";
import {
  classifyRecoveryCondition,
  ClaudeSessionUnavailableError,
  describeFailure,
  sanitizeFailureDetail,
} from "./session-errors.js";
import { buildClaudeSpawnBinding, type ClaudeSpawnLegComposer } from "./spawn-legs.js";
import {
  DriverResumeResultSchema,
  ForkConversationResultSchema,
  type CreateSessionParams,
  type DriverResumeResult,
  type ForkConversationParams,
  type ForkConversationResult,
  type ProviderSessionHandle,
  type ResumeSessionParams,
} from "../../provider-driver.js";

/** What the establishment legs spawn through and hand an adopted channel to. */
export interface ClaudeSessionEstablishmentDependencies {
  readonly transport: ClaudeSessionTransport;
  readonly mintProviderSessionId: () => string;
  readonly mintBindingId: () => string;
  readonly spawnLegs: ClaudeSpawnLegComposer;
  /** Records an output-speed level the provider refused at spawn. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * Installs an adopted channel as the session's live slot, holding its `initialize` fast-mode
   * reading as the binding's first observation; may throw, and then adopts nothing.
   */
  readonly registerLiveSession: (
    live: LiveClaudeSession,
    initializeFastMode: ClaudeFastModeDeclaration,
  ) => void;
  /**
   * Releases what a rewound predecessor held once its successor is adopted: its unsettled frames,
   * run routes, subagent gate and compaction waits. Its channel is disposed after.
   */
  readonly releaseSupersededPredecessor: (
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
  ) => void;
}

/** The `failed` resume arm with its sanitized detail; carries no `bindingId`. */
export function buildClaudeResumeFailure(
  condition: RecoveryCondition,
  detail: string,
): DriverResumeResult {
  return {
    status: "failed",
    recoveryCondition: condition,
    providerFailureDetail: sanitizeFailureDetail(detail),
  };
}

/**
 * Disposes a channel the driver refuses to adopt and returns a note for the refusal text. A
 * disposal error is not rethrown (it would hide the identity divergence) and nothing is retained
 * (a held slot would make create un-retryable); the transport takes ownership on `dispose`.
 */
async function disposeRefusedChannel(
  channel: ClaudeProviderProcess,
  reason: ClaudeChannelDisposalReason,
): Promise<string> {
  try {
    await channel.dispose(reason);
    return "";
  } catch (error) {
    return ` The refused provider channel could not be disposed: ${describeFailure(error)}`;
  }
}

/**
 * Runs the create, resume and rewind legs inside the slot claim the lifecycle holds for them. Every
 * attached channel is registered or disposed before a leg returns or throws.
 */
export class ClaudeSessionEstablishment {
  readonly #transport: ClaudeSessionTransport;
  readonly #mintProviderSessionId: () => string;
  readonly #mintBindingId: () => string;
  readonly #spawnLegs: ClaudeSpawnLegComposer;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #registerLiveSession: ClaudeSessionEstablishmentDependencies["registerLiveSession"];
  readonly #releaseSupersededPredecessor: (
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
  ) => void;

  constructor(dependencies: ClaudeSessionEstablishmentDependencies) {
    this.#transport = dependencies.transport;
    this.#mintProviderSessionId = dependencies.mintProviderSessionId;
    this.#mintBindingId = dependencies.mintBindingId;
    this.#spawnLegs = dependencies.spawnLegs;
    this.#diagnostics = dependencies.diagnostics;
    this.#registerLiveSession = dependencies.registerLiveSession;
    this.#releaseSupersededPredecessor = dependencies.releaseSupersededPredecessor;
  }

  /**
   * Spawns a process pinned to a freshly minted provider session id and registers it. Throws
   * `ClaudeSessionUnavailableError` for an empty provider account or a diverged pin.
   */
  async establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Before the spawn, so a request without a billing identity never reaches a process.
    if (isUnusableAdmittedProviderAccountId(params.providerAccountId)) {
      throw new ClaudeSessionUnavailableError("provider_account_unusable", {
        sessionId: params.sessionId,
      });
    }
    const pinnedProviderSessionId = this.#mintProviderSessionId();
    // Built once and retained: a fork relaunches from the legs this process launched under.
    const spawnBoundLegs = this.#spawnLegs.buildSpawnBoundLegs(params);
    const attachment = await this.#transport.spawnSession({
      ...spawnBoundLegs,
      providerSessionId: pinnedProviderSessionId,
      config: params.config,
    });

    if (attachment.providerSessionId !== pinnedProviderSessionId) {
      const disposalNote = await disposeRefusedChannel(
        attachment.channel,
        "spawn_identity_diverged",
      );
      throw new ClaudeSessionUnavailableError("session_id_pin_diverged", {
        sessionId: params.sessionId,
        detail:
          `Pinned ${pinnedProviderSessionId}, announced ${attachment.providerSessionId}.` +
          `${disposalNote}`,
      });
    }

    // Every exit here registers or disposes the channel, or the slot frees around a running
    // process. The window can throw: `buildClaudeSpawnBinding` digests a caller-supplied schema
    // (cyclic ones throw) and registration calls the transport's `onTurnTerminal`.
    try {
      const appliedOutputSpeed = await this.#applyOutputSpeed(
        attachment.channel,
        params.sessionId,
        params.outputSpeed,
      );
      this.#registerLiveSession(
        {
          sessionId: params.sessionId,
          providerSessionId: attachment.providerSessionId,
          channel: attachment.channel,
          spawnBinding: buildClaudeSpawnBinding(params),
          spawnBoundLegs: spawnBoundLegs,
          appliedOutputSpeed,
          establishment: { mode: "fresh" },
          // Captured, not resolved, so the enumeration reports the account this process runs under.
          admittedProviderAccountId: readAdmittedProviderAccountId(params.providerAccountId),
        },
        attachment.initializeFastMode,
      );
    } catch (error) {
      // Re-throw the original cause: `createSession` has no degraded arm to carry a wrapper.
      await disposeRefusedChannel(attachment.channel, "establishment_failed");
      throw error;
    }

    // Claude resumes by session id (`--resume <session-id>`), so the handle is that id.
    return {
      providerSessionId: attachment.providerSessionId,
      resumeHandle: attachment.providerSessionId,
    };
  }

  /**
   * Resumes a provider session by its handle and registers it only when the transport answers with
   * that same session; every failure returns through the `failed` arm.
   */
  async establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Before the spawn and through `failed`: a raw rejection would reach a caller with no arm.
    if (isUnusableAdmittedProviderAccountId(params.providerAccountId)) {
      return buildClaudeResumeFailure(
        "recovery-needed",
        "ResumeSessionParams.providerAccountId is present but empty; an account was meant to " +
          "be bound and none was.",
      );
    }
    const spawnBoundLegs = this.#spawnLegs.buildSpawnBoundLegs(params);
    let attachment: ClaudeResumedSessionAttachment;
    try {
      attachment = await this.#transport.resumeSession({
        ...spawnBoundLegs,
        resumeHandle: params.resumeHandle,
      });
    } catch (error) {
      return buildClaudeResumeFailure(classifyRecoveryCondition(error), describeFailure(error));
    }

    // Identity gate. Claude answers a resume it cannot honor (a working-directory mismatch is
    // documented) by starting a fresh session under its own id, which must not be adopted.
    if (attachment.providerSessionId !== params.resumeHandle) {
      const disposalNote = await disposeRefusedChannel(
        attachment.channel,
        "resume_identity_diverged",
      );
      return buildClaudeResumeFailure(
        "recovery-needed",
        `Resume handle ${params.resumeHandle} was answered by session ` +
          `${attachment.providerSessionId}; the provider started a replacement session rather ` +
          `than resuming.${disposalNote}`,
      );
    }

    // Every exit until registration registers or disposes the channel. The window can throw (the
    // binding minter, `buildClaudeSpawnBinding`'s schema digest, the transport's `onTurnTerminal`),
    // and resume's failure channel is the `failed` arm, so a throw must not escape.
    let validatedResumeResult: DriverResumeResult;
    try {
      const resumed: DriverResumeResult = {
        status: "resumed",
        bindingId: this.#mintBindingId(),
        sessionPosition: attachment.sessionPosition,
      };
      // An out-of-contract `resumed` arm is a provider failure: `recovery-needed`, not a throw.
      const validated = DriverResumeResultSchema.safeParse(resumed);
      if (!validated.success) {
        const disposalNote = await disposeRefusedChannel(
          attachment.channel,
          "resume_result_invalid",
        );
        return buildClaudeResumeFailure(
          "recovery-needed",
          `The Claude transport reported a resume that fails the driver resume contract: ` +
            `${validated.error.message}${disposalNote}`,
        );
      }
      validatedResumeResult = validated.data;

      // A resume is a fresh process, which holds no flag setting until it is told again.
      const appliedOutputSpeed = await this.#applyOutputSpeed(
        attachment.channel,
        params.sessionId,
        params.outputSpeed,
      );
      this.#registerLiveSession(
        {
          sessionId: params.sessionId,
          providerSessionId: attachment.providerSessionId,
          channel: attachment.channel,
          spawnBinding: buildClaudeSpawnBinding(params),
          spawnBoundLegs: spawnBoundLegs,
          appliedOutputSpeed,
          // The identity gate guarantees this is the thread the daemon has been emitting against.
          establishment: { mode: "resume", priorEmittedThreadId: attachment.providerSessionId },
          // No record to reconcile: a resume only proceeds on an EMPTY slot (`resumeSession`
          // checks).
          admittedProviderAccountId: readAdmittedProviderAccountId(params.providerAccountId),
        },
        attachment.initializeFastMode,
      );
    } catch (error) {
      const disposalNote = await disposeRefusedChannel(attachment.channel, "establishment_failed");
      // `recovery-needed`, not `reauth-required`: adoption failed after a resume that succeeded.
      return buildClaudeResumeFailure(
        "recovery-needed",
        `The Claude session resumed but could not be adopted: ${describeFailure(error)}` +
          `${disposalNote}`,
      );
    }
    return validatedResumeResult;
  }

  /**
   * Forks the predecessor's conversation into a new provider session and adopts it; every refusal
   * degrades and leaves the predecessor untouched. On adoption the predecessor is released and its
   * channel disposed.
   */
  async establishRewoundSession(
    params: ForkConversationParams,
    predecessor: LiveClaudeSession,
  ): Promise<ForkConversationResult> {
    const rewoundSpawnBoundLegs: ClaudeSpawnBoundLegs = {
      // The predecessor's own legs, re-realized verbatim; any other source relaunches under a
      // configuration nobody chose.
      ...predecessor.spawnBoundLegs,
      // A fresh gate: every subagent the old gate held a slot for died with the process.
      subagentAdmission: this.#spawnLegs.buildSubagentAdmission(
        params.sessionId,
        predecessor.spawnBoundLegs.subagentPolicy,
      ),
    };
    let attachment: ClaudeResumedSessionAttachment;
    try {
      attachment = await this.#transport.rewindSession({
        ...rewoundSpawnBoundLegs,
        resumeHandle: predecessor.providerSessionId,
        targetPosition: params.position,
      });
    } catch (error) {
      // The predecessor is untouched, so a retry is safe. Degraded, not thrown: the caller has a
      // fallback arm.
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: `rewind-refused: ${sanitizeFailureDetail(describeFailure(error))}`,
      });
    }

    // A rewind answering with the id it was given did not fork, so the lineage would be wrong.
    if (attachment.providerSessionId === predecessor.providerSessionId) {
      // Disposing the predecessor's own channel would kill the session about to be restored.
      const disposalNote =
        attachment.channel === predecessor.channel
          ? ""
          : await disposeRefusedChannel(attachment.channel, "resume_identity_diverged");
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction:
          `rewind-not-forked: the provider answered with session ` +
          `${attachment.providerSessionId} rather than a fork.${disposalNote}`,
      });
    }

    // Every exit here either registers the new channel or disposes it: an escaping throw would
    // orphan the forked process while the claim restores the predecessor.
    let validatedRollbackResult: ForkConversationResult;
    try {
      const applied = {
        status: "applied" as const,
        sessionPosition: attachment.sessionPosition,
        bindingId: this.#mintBindingId(),
      };
      const validated = ForkConversationResultSchema.safeParse(applied);
      if (!validated.success) {
        const disposalNote = await disposeRefusedChannel(
          attachment.channel,
          "resume_result_invalid",
        );
        return ForkConversationResultSchema.parse({
          status: "degraded",
          fallbackAction:
            `rewind-result-invalid: ${sanitizeFailureDetail(validated.error.message)}` +
            `${disposalNote}`,
        });
      }
      validatedRollbackResult = validated.data;

      // The fork is a fresh process too, so the level the predecessor accepted is applied again.
      const appliedOutputSpeed = await this.#applyOutputSpeed(
        attachment.channel,
        params.sessionId,
        predecessor.appliedOutputSpeed,
      );
      this.#registerLiveSession(
        {
          sessionId: params.sessionId,
          providerSessionId: attachment.providerSessionId,
          channel: attachment.channel,
          spawnBinding: predecessor.spawnBinding,
          spawnBoundLegs: rewoundSpawnBoundLegs,
          appliedOutputSpeed,
          // Bases like a resume, keyed on the predecessor's id (the only one spend was emitted
          // under); a zero base would re-meter earlier turns. If the provider's counter restarts on
          // `--fork-session` (unmeasured), deltas floor at zero and a diagnostic is recorded.
          establishment: { mode: "resume", priorEmittedThreadId: predecessor.providerSessionId },
          // Inherited: a fork continues the run already admitted, and re-reading the registry could
          // re-bill a session the daemon never re-admitted.
          admittedProviderAccountId: predecessor.admittedProviderAccountId,
        },
        attachment.initializeFastMode,
      );
    } catch (error) {
      const disposalNote = await disposeRefusedChannel(attachment.channel, "establishment_failed");
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction:
          `rewind-adoption-failed: ${sanitizeFailureDetail(describeFailure(error))}` +
          `${disposalNote}`,
      });
    }

    // After adoption commits, outside the try: a failed adoption keeps a running predecessor
    // correlated.
    this.#releaseSupersededPredecessor(params.sessionId, predecessor);
    await disposeRefusedChannel(predecessor.channel, "session_closed");
    return validatedRollbackResult;
  }

  // Sent before registration, inside each leg's dispose-or-register window, so a transport failure
  // disposes the channel; a refusal leaves the process on its own level and records none applied.
  async #applyOutputSpeed(
    channel: ClaudeProviderProcess,
    sessionId: SessionId,
    level: string | undefined,
  ): Promise<string | undefined> {
    return level === undefined
      ? undefined
      : await applyClaudeOutputSpeed(channel, sessionId, level, this.#diagnostics);
  }
}
