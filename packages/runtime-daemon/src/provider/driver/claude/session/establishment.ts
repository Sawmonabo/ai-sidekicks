// The establishment legs of a Claude session: spawning a fresh process, resuming one by its handle,
// and forking one at a recorded message. Each leg attaches a channel, gates its identity and the
// level it runs at, carries a planning session's Plan onto the new process, and either registers
// it with the lifecycle or disposes it.
//
// A resume must never silently replace the provider session under the same canonical run:
// - `DriverResumeResult`'s `failed` arm carries no `bindingId`, so failed and resumed cannot mix.
// - It counts as `resumed` only when the transport reports the session id the handle names
//   (Claude starts a fresh session when the recorded working directory changed).
// - Every refused attachment is disposed before `failed` is returned.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RecoveryCondition } from "@ai-sidekicks/contracts/provider/driver/recovery";
import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { applyClaudeOutputSpeed } from "../output-speed.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { readClaudeCommandChoices, unreadableClaudeCommandChoices } from "./answered-commands.js";
import type { ClaudeModelFigures } from "./model-figures.js";
import { deriveClaudeReplyReserve, type ClaudeReplyReserve } from "./reply-reserve.js";
import { canRunClaudeLevel } from "./permission-level.js";
import {
  sendClaudeControlRequest,
  type ClaudeChannelDisposalReason,
  type ClaudeResumedSessionAttachment,
  type ClaudeProviderProcess,
  type ClaudeSessionAttachment,
  type ClaudeSessionFolderReadRequest,
  type ClaudeSessionTransport,
  type ClaudeSpawnBoundLegs,
} from "./transport.js";
import {
  type ClaudeSessionLifecycleDependencies,
  isUnusableAdmittedProviderAccountId,
  type LiveClaudeSession,
  readAdmittedProviderAccountId,
} from "./state.js";
import {
  classifyRecoveryCondition,
  ClaudeSessionUnavailableError,
  describeFailure,
  sanitizeFailureDetail,
} from "./errors.js";
import { buildClaudeSpawnBinding, type ClaudeSpawnLegComposer } from "../spawn/legs.js";
import {
  DriverResumeResultSchema,
  MoveSessionToForkResultSchema,
  type CreateSessionParams,
  type DriverResumeResult,
  type MoveSessionToForkParams,
  type MoveSessionToForkResult,
  type ProviderSessionHandle,
  type ResumeSessionParams,
} from "../../contract.js";

// What the creation-time process gives a session to hold: its command choices.
type ClaudeCreationFigures = Pick<LiveClaudeSession, "commandChoices">;

/** What the establishment legs spawn through and hand an adopted channel to. */
export interface ClaudeSessionEstablishmentDependencies {
  readonly transport: ClaudeSessionTransport;
  readonly mintProviderSessionId: () => string;
  readonly mintBindingId: () => string;
  readonly spawnLegs: ClaudeSpawnLegComposer;
  /** The operating system the daemon runs on, whose Bash sandbox decides Sandboxed. */
  readonly operatingSystem: ClaudeSessionLifecycleDependencies["operatingSystem"];
  /** Records an output-speed level the provider refused at spawn. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** The figures held for the installed build, each read once and reused by every session. */
  readonly modelFigures: () => ClaudeModelFigures;
  /** Points the session's binding at a rewind's fork; see the lifecycle's dependency. */
  readonly rebindRuntimeBinding: ClaudeSessionLifecycleDependencies["rebindRuntimeBinding"];
  /**
   * Installs an adopted channel as the session's live slot, holding its `initialize` fast-mode
   * reading as the binding's first observation; may throw, and then adopts nothing.
   */
  readonly registerLiveSession: (live: LiveClaudeSession) => void;
  /**
   * Raises the notices an adopted process's settings readback calls for. Never throws: the
   * process is adopted either way.
   */
  readonly reportSettingsReadback: (
    sessionId: SessionId,
    attachment: ClaudeSessionAttachment,
  ) => Promise<void>;
  /**
   * Releases what a rewound predecessor held once its successor is adopted: its runs still in
   * flight (failed), run routes and compaction waits. Its channel is disposed after.
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
 * Refuses a process that cannot run at the session's level before it is adopted. Throws
 * `permission_level_unavailable`.
 */
function assertLevelRuns(
  sessionId: SessionId,
  posture: ExecutionPosture | undefined,
  runningModel: string,
  attachment: ClaudeSessionAttachment,
  operatingSystem: ClaudeSessionLifecycleDependencies["operatingSystem"],
): void {
  if (
    posture !== undefined &&
    !canRunClaudeLevel(posture.mode, runningModel, attachment.initialize, operatingSystem)
  ) {
    throw new ClaudeSessionUnavailableError("permission_level_unavailable", {
      sessionId,
      detail: `Level ${posture.mode}.`,
    });
  }
}

/**
 * Build or Plan lives with the session, not the process: a process that comes after one in Plan
 * plans too. A process starts at its level's own mode, so only Plan is sent. Throws when Claude
 * Code refuses it, so the process is not adopted in the wrong mode.
 */
async function carrySessionMode(
  channel: ClaudeProviderProcess,
  mode: SessionMode,
): Promise<SessionMode> {
  if (mode === "plan") {
    await sendClaudeControlRequest(channel, { subtype: "set_permission_mode", mode: "plan" });
  }
  return mode;
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
  readonly #operatingSystem: ClaudeSessionLifecycleDependencies["operatingSystem"];
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #modelFigures: () => ClaudeModelFigures;
  readonly #rebindRuntimeBinding: ClaudeSessionLifecycleDependencies["rebindRuntimeBinding"];
  readonly #registerLiveSession: ClaudeSessionEstablishmentDependencies["registerLiveSession"];
  readonly #reportSettingsReadback: (
    sessionId: SessionId,
    attachment: ClaudeSessionAttachment,
  ) => Promise<void>;
  readonly #releaseSupersededPredecessor: (
    sessionId: SessionId,
    predecessor: LiveClaudeSession,
  ) => void;

  constructor(dependencies: ClaudeSessionEstablishmentDependencies) {
    this.#transport = dependencies.transport;
    this.#mintProviderSessionId = dependencies.mintProviderSessionId;
    this.#mintBindingId = dependencies.mintBindingId;
    this.#spawnLegs = dependencies.spawnLegs;
    this.#operatingSystem = dependencies.operatingSystem;
    this.#diagnostics = dependencies.diagnostics;
    this.#modelFigures = dependencies.modelFigures;
    this.#rebindRuntimeBinding = dependencies.rebindRuntimeBinding;
    this.#registerLiveSession = dependencies.registerLiveSession;
    this.#reportSettingsReadback = dependencies.reportSettingsReadback;
    this.#releaseSupersededPredecessor = dependencies.releaseSupersededPredecessor;
  }

  /**
   * Spawns a process pinned to a freshly minted provider session id and registers it. Throws
   * `ClaudeSessionUnavailableError` for an empty provider account, a larger-window figure (the
   * model id names the window) or a diverged pin.
   */
  async establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Before the spawn, so a request without a billing identity never reaches a process.
    if (isUnusableAdmittedProviderAccountId(params.providerAccountId)) {
      throw new ClaudeSessionUnavailableError("provider_account_unusable", {
        sessionId: params.sessionId,
      });
    }
    if (params.largerWindow !== undefined) {
      throw new ClaudeSessionUnavailableError("larger_window_figure_unsupported", {
        sessionId: params.sessionId,
      });
    }
    const pinnedProviderSessionId = this.#mintProviderSessionId();
    // Built once and retained: a fork relaunches from the legs this process launched under.
    const spawnBoundLegs = await this.#spawnLegs.buildSpawnBoundLegs(params);
    const creationFigures = this.#readCreationFigures(spawnBoundLegs);
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
      assertLevelRuns(
        params.sessionId,
        params.executionPosture,
        spawnBoundLegs.model,
        attachment,
        this.#operatingSystem,
      );
      const appliedOutputSpeed = await this.#applyOutputSpeed(
        attachment.channel,
        params.sessionId,
        params.outputSpeed,
      );
      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: buildClaudeSpawnBinding(params),
        spawnBoundLegs: spawnBoundLegs,
        executionPosture: params.executionPosture,
        // A spawn runs at its level's own mode, so the session builds until it is moved to plan.
        sessionMode: "build",
        runningModel: spawnBoundLegs.model,
        advisorModel: spawnBoundLegs.advisorModel,
        outputStyle: spawnBoundLegs.outputStyle,
        initialize: attachment.initialize,
        ...creationFigures,
        attachedAdvisor: attachment.settingsReadback.attachedAdvisor,
        appliedOutputSpeed,
        establishment: { mode: "fresh" },
        // Captured, not resolved, so the enumeration reports the account this process runs under.
        admittedProviderAccountId: readAdmittedProviderAccountId(params.providerAccountId),
      });
    } catch (error) {
      // Re-throw the original cause: `createSession` has no degraded arm to carry a wrapper.
      await disposeRefusedChannel(attachment.channel, "establishment_failed");
      throw error;
    }
    await this.#reportSettingsReadback(params.sessionId, attachment);

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
    if (params.largerWindow !== undefined) {
      return buildClaudeResumeFailure(
        "recovery-needed",
        new ClaudeSessionUnavailableError("larger_window_figure_unsupported", {
          sessionId: params.sessionId,
        }).message,
      );
    }
    let attachment: ClaudeResumedSessionAttachment;
    let spawnBoundLegs: ClaudeSpawnBoundLegs;
    let creationFigures: ClaudeCreationFigures;
    try {
      spawnBoundLegs = await this.#spawnLegs.buildSpawnBoundLegs(params);
      creationFigures = this.#readCreationFigures(spawnBoundLegs);
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
        resumeHandle: attachment.providerSessionId,
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

      assertLevelRuns(
        params.sessionId,
        params.executionPosture,
        spawnBoundLegs.model,
        attachment,
        this.#operatingSystem,
      );
      // A resume is a fresh process, which holds no flag setting until it is told again.
      const appliedOutputSpeed = await this.#applyOutputSpeed(
        attachment.channel,
        params.sessionId,
        params.outputSpeed,
      );
      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: buildClaudeSpawnBinding(params),
        spawnBoundLegs: spawnBoundLegs,
        executionPosture: params.executionPosture,
        sessionMode: await carrySessionMode(attachment.channel, params.mode),
        runningModel: spawnBoundLegs.model,
        advisorModel: spawnBoundLegs.advisorModel,
        outputStyle: spawnBoundLegs.outputStyle,
        initialize: attachment.initialize,
        ...creationFigures,
        attachedAdvisor: attachment.settingsReadback.attachedAdvisor,
        appliedOutputSpeed,
        // The identity gate guarantees this is the thread the daemon has been emitting against.
        establishment: { mode: "resume", priorEmittedThreadId: attachment.providerSessionId },
        // No record to reconcile: a resume only proceeds on an EMPTY slot (`resumeSession`
        // checks).
        admittedProviderAccountId: readAdmittedProviderAccountId(params.providerAccountId),
      });
    } catch (error) {
      const disposalNote = await disposeRefusedChannel(attachment.channel, "establishment_failed");
      // `recovery-needed`, not `reauth-required`: adoption failed after a resume that succeeded.
      return buildClaudeResumeFailure(
        "recovery-needed",
        `The Claude session resumed but could not be adopted: ${describeFailure(error)}` +
          `${disposalNote}`,
      );
    }
    await this.#reportSettingsReadback(params.sessionId, attachment);
    return validatedResumeResult;
  }

  /**
   * Forks the predecessor's conversation into a new provider session, points `params.bindingId` at
   * it and adopts it; every refusal degrades and leaves the predecessor and the binding as they
   * were. On adoption the predecessor is released and its channel disposed.
   */
  async establishRewoundSession(
    params: MoveSessionToForkParams,
    predecessor: LiveClaudeSession,
  ): Promise<MoveSessionToForkResult> {
    const rewoundSpawnBoundLegs: ClaudeSpawnBoundLegs = {
      // The predecessor's own legs, re-realized verbatim; any other source relaunches under a
      // configuration nobody chose. The level is the one it runs at now, after any live move.
      ...predecessor.spawnBoundLegs,
      executionPosture: predecessor.executionPosture,
      // The model the session runs on now, after any session-long switch Claude Code made.
      model: predecessor.runningModel,
      // The session's advisor and output style now, after any `/advisor` or `/output-style`.
      advisorModel: predecessor.advisorModel,
      outputStyle: predecessor.outputStyle,
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
      return MoveSessionToForkResultSchema.parse({
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
      return MoveSessionToForkResultSchema.parse({
        status: "degraded",
        fallbackAction:
          `rewind-not-forked: the provider answered with session ` +
          `${attachment.providerSessionId} rather than a fork.${disposalNote}`,
      });
    }

    // Every exit here either registers the new channel or disposes it: an escaping throw would
    // orphan the forked process while the claim restores the predecessor.
    let validatedRollbackResult: MoveSessionToForkResult;
    let isRebound = false;
    try {
      const applied = { status: "applied" as const, sessionPosition: attachment.sessionPosition };
      const validated = MoveSessionToForkResultSchema.safeParse(applied);
      if (!validated.success) {
        const disposalNote = await disposeRefusedChannel(
          attachment.channel,
          "resume_result_invalid",
        );
        return MoveSessionToForkResultSchema.parse({
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
      const sessionMode = await carrySessionMode(attachment.channel, predecessor.sessionMode);
      // Durable before the predecessor is let go, so a daemon restart resumes the fork; the
      // session it leaves is recorded in the same write.
      await this.#rebindRuntimeBinding({
        bindingId: params.bindingId,
        resumeHandle: attachment.providerSessionId,
        leftConversations: [
          {
            sessionId: params.sessionId,
            providerAccountId: predecessor.admittedProviderAccountId ?? undefined,
            conversationId: predecessor.providerSessionId,
          },
        ],
      });
      isRebound = true;
      this.#registerLiveSession({
        sessionId: params.sessionId,
        providerSessionId: attachment.providerSessionId,
        channel: attachment.channel,
        spawnBinding: predecessor.spawnBinding,
        spawnBoundLegs: rewoundSpawnBoundLegs,
        executionPosture: predecessor.executionPosture,
        sessionMode,
        runningModel: rewoundSpawnBoundLegs.model,
        advisorModel: rewoundSpawnBoundLegs.advisorModel,
        outputStyle: rewoundSpawnBoundLegs.outputStyle,
        initialize: attachment.initialize,
        // The same folder and home as the predecessor's, so its reading still holds.
        commandChoices: predecessor.commandChoices,
        attachedAdvisor: attachment.settingsReadback.attachedAdvisor,
        appliedOutputSpeed,
        // Bases like a resume, keyed on the predecessor's id (the only one spend was emitted
        // under); a zero base would re-meter earlier turns. If the provider's counter restarts on
        // `--fork-session` (unmeasured), deltas floor at zero and a diagnostic is recorded.
        establishment: { mode: "resume", priorEmittedThreadId: predecessor.providerSessionId },
        // Inherited: a fork continues the run already admitted, and re-reading the registry could
        // re-bill a session the daemon never re-admitted.
        admittedProviderAccountId: predecessor.admittedProviderAccountId,
      });
    } catch (error) {
      if (isRebound) {
        await this.#pointBindingBack(params, predecessor);
      }
      const disposalNote = await disposeRefusedChannel(attachment.channel, "establishment_failed");
      return MoveSessionToForkResultSchema.parse({
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
    await this.#reportSettingsReadback(params.sessionId, attachment);
    return validatedRollbackResult;
  }

  // The predecessor stays the session's after a failed adoption, so its binding names it again; a
  // failed write is recorded, since the rewind's own refusal is what its caller gets.
  async #pointBindingBack(
    params: MoveSessionToForkParams,
    predecessor: LiveClaudeSession,
  ): Promise<void> {
    try {
      await this.#rebindRuntimeBinding({
        bindingId: params.bindingId,
        resumeHandle: predecessor.providerSessionId,
        leftConversations: [],
      });
    } catch (error) {
      this.#diagnostics.emit({
        provider: CLAUDE_DRIVER_NAME,
        kind: "process_report_failed",
        rawWireType: null,
        dispositionReason:
          "pointing the binding back after a failed rewind failed: " +
          sanitizeFailureDetail(describeFailure(error)),
        details: { sessionId: params.sessionId, bindingId: params.bindingId },
      });
    }
  }

  /**
   * Reads the reply reserve for the model the session runs on now when none is held for it at the
   * session's endpoint, in one control-only process in the session's folder; a model already read
   * there is never read again.
   */
  readReplyReserveForRunningModel(live: LiveClaudeSession): void {
    const model = live.runningModel;
    const figures = this.#modelFigures();
    const legs = live.spawnBoundLegs;
    const place: ClaudeSessionFolderReadRequest = {
      spawnEnvironment: legs.spawnEnvironment,
      workingDirectory: legs.workingDirectory,
      model,
    };
    if (figures.replyReserveOf(place) !== undefined) {
      return;
    }
    const replyReserve: Promise<ClaudeReplyReserve> = this.#transport.readReplyReserve(place).then(
      (reads) => deriveClaudeReplyReserve(model, reads),
      (error: unknown): ClaudeReplyReserve => {
        const reason = sanitizeFailureDetail(describeFailure(error));
        this.#reportControlOnlyReadFailure(reason, { sessionId: live.sessionId, model });
        figures.forgetReplyReserve(place, replyReserve);
        return { kind: "unread", reason };
      },
    );
    figures.holdReplyReserve(place, replyReserve);
  }

  // Read beside the spawn, so creating a session waits on nothing more, and only when its folder
  // and account's choices or its model's reply reserve at its endpoint were never read. Never
  // rejects: a failed read is recorded, held as its reason for the answer that needs it, and
  // dropped from the store so the next session reads it again.
  #readCreationFigures(legs: ClaudeSpawnBoundLegs): ClaudeCreationFigures {
    const figures = this.#modelFigures();
    const place: ClaudeSessionFolderReadRequest = {
      spawnEnvironment: legs.spawnEnvironment,
      workingDirectory: legs.workingDirectory,
      model: legs.model,
    };
    const heldChoices = figures.commandChoicesOf(place);
    const heldReserve = figures.replyReserveOf(place);
    if (heldChoices !== undefined && heldReserve !== undefined) {
      return { commandChoices: heldChoices };
    }
    const read = this.#transport
      .readCreationFigures({
        ...place,
        contextReadModels: figures.contextReadModels(legs.spawnEnvironment),
      })
      .then(
        (reading) => {
          figures.recordContextReads(legs.spawnEnvironment, reading.contextReads);
          return {
            commandChoices: readClaudeCommandChoices(reading),
            replyReserve: deriveClaudeReplyReserve(legs.model, reading.replyReserveReads),
          };
        },
        (error: unknown) => {
          const detail = sanitizeFailureDetail(describeFailure(error));
          this.#reportControlOnlyReadFailure(detail, { sessionId: legs.sessionId });
          if (heldChoices === undefined) {
            figures.forgetCommandChoices(place, commandChoices);
          }
          if (heldReserve === undefined) {
            figures.forgetReplyReserve(place, replyReserve);
          }
          return {
            commandChoices: unreadableClaudeCommandChoices(detail),
            replyReserve: { kind: "unread", reason: detail } as const,
          };
        },
      );
    // Only what was never read is held from this read; a held figure stays the one in use.
    const commandChoices = heldChoices ?? read.then((figure) => figure.commandChoices);
    const replyReserve = heldReserve ?? read.then((figure) => figure.replyReserve);
    if (heldChoices === undefined) {
      figures.holdCommandChoices(place, commandChoices);
    }
    if (heldReserve === undefined) {
      figures.holdReplyReserve(place, replyReserve);
    }
    return { commandChoices };
  }

  #reportControlOnlyReadFailure(reason: string, details: Record<string, string>): void {
    this.#diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "control_only_read_failed",
      rawWireType: null,
      dispositionReason: reason,
      details,
    });
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
