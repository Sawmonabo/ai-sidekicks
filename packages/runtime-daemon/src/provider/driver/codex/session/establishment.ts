// The Codex establishment legs: starting a session's conversation on its account's service,
// reopening it at a daemon restart by forking it there with every setting the session holds, and
// resuming a held one in place after its service came back or moved; then installing the record
// and rebinding the routing band. A failed resume never becomes a new conversation: it returns the
// typed `recovery-needed` failure.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import { composeCodexShellEnvironmentPolicy } from "../../../spawn-env.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import type { CodexProviderCommandCache } from "../commands.js";
import { createCodexDeliveryMemory } from "../delivery/memory.js";
import { readCodexLargerWindow } from "../model-windows.js";
import type { CodexNotificationRouting } from "../notification-routing.js";
import { composeCodexServiceTier, type CodexOutputSpeed } from "../output-speed.js";
import type { CodexRunRoutes } from "../run/routes.js";
import type { CodexServiceRegistry } from "../service/registry.js";
import type { CodexService } from "../service/supervisor.js";
import { composeCodexThreadParams, type CodexThreadSettings } from "../thread/settings.js";
import { composeCodexThreadPermissionProfiles } from "../thread/permission-profiles.js";
import { assertCodexThreadProfile, readThread, readThreadReasoningEffort } from "../thread/view.js";
import { reportDiagnosticFromDetachedFrame } from "../transport/diagnostics.js";
import { classifyResumeRecoveryCondition } from "../auth-status.js";
import { readCodexRoleFileWithheldFields, writeCodexHelperRoles } from "./helper-roles.js";
import {
  type CodexConversationRelease,
  unsubscribeCodexThreadQuietly,
} from "./conversation-release.js";
import { updateCodexSessionMode } from "./controls.js";
import {
  CODEX_INVALID_REQUEST_CODE,
  CodexDriverConfigError,
  CodexLargerWindowUnavailableError,
  CodexProviderRequestError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./errors.js";
import type { CodexConversationForks } from "./fork.js";
import { type CodexListedTurn, readCodexTurns } from "./history.js";
import type { CodexSessionSlots } from "./slots.js";
import {
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexLostRunFailure,
  type CodexSessionRecord,
} from "./state.js";
import {
  DriverResumeResultSchema,
  type CreateSessionParams,
  type DriverResumeResult,
  type ProviderSessionHandle,
  type ResumeSessionParams,
  type SubagentDefinition,
} from "../../contract.js";

/** The record for a just-established thread; every per-turn register starts empty. */
function composeSessionRecord(
  diagnostics: DriverDiagnosticsEmitter,
  established: Pick<
    CodexSessionRecord,
    | "sessionId"
    | "service"
    | "threadId"
    | "bindingId"
    | "providerAccountId"
    | "turnBoundaries"
    | "threadSettings"
    | "executionPosture"
    | "sessionMode"
    | "outputSpeedRequest"
    | "declaredOutputSpeed"
    | "reasoningEffort"
  >,
): CodexSessionRecord {
  return {
    ...established,
    permissionProfiles: composeCodexThreadPermissionProfiles(established.threadSettings),
    isConfigForkOwed: false,
    leftThreadIdsAwaitingBinding: [],
    turnIdByClientMessageId: new Map(),
    runIdByActiveTurnId: new Map(),
    settledTurnIds: new Set(),
    interruptedRunIdByTurnId: new Map(),
    unsettledOutputSpeedRuns: new Map(),
    lastSteerSend: Promise.resolve(),
    pauseRunIdByTurnId: new Map(),
    pausedRunIdByInterruptedTurnId: new Map(),
    continuesAwaitingPause: new Map(),
    turnInputByTurnId: new Map(),
    delivery: createCodexDeliveryMemory(diagnostics),
  };
}

/** A conversation resumed in place, and its turns as Codex listed them; none when it failed. */
export interface CodexInPlaceResume {
  readonly result: DriverResumeResult;
  readonly listedTurns: readonly CodexListedTurn[];
}

// What a resume reads back: the conversation's turns, its declared tier and its effort.
interface CodexResumedThread {
  readonly listedTurns: CodexListedTurn[];
  readonly declaredOutputSpeed: CodexSessionRecord["declaredOutputSpeed"];
  readonly reasoningEffort: CodexSessionRecord["reasoningEffort"];
}

// Codex's refusal to resume a conversation another runtime still writes.
const CODEX_ACTIVE_WRITER_MESSAGE = "active writer";

function isActiveWriterRefusal(cause: unknown): boolean {
  return (
    cause instanceof CodexProviderRequestError &&
    cause.providerErrorCode === CODEX_INVALID_REQUEST_CODE &&
    cause.providerMessage.includes(CODEX_ACTIVE_WRITER_MESSAGE)
  );
}

/** The dependencies and lifecycle owners the establishment legs write into. */
export interface CodexSessionEstablishmentDependencies {
  readonly options: Pick<
    CodexLifecycleOptions,
    | "reportDiagnostic"
    | "diagnostics"
    | "onLostRunFailure"
    | "spawnContext"
    | "credentialPolicy"
    | "providerBaseEnvironment"
    | "operatingSystem"
    | "toolServerRoute"
    | "helperRolesFolder"
  >;
  readonly newBindingId: () => string;
  readonly slots: CodexSessionSlots;
  readonly services: CodexServiceRegistry;
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly outputSpeed: CodexOutputSpeed;
  readonly notificationRouting: CodexNotificationRouting;
  readonly providerCommands: CodexProviderCommandCache;
  readonly runRoutes: CodexRunRoutes;
  readonly forks: CodexConversationForks;
  readonly release: CodexConversationRelease;
}

/**
 * Runs the create and resume legs inside the slot the lifecycle claimed for them. The service
 * stays up whatever a leg does to its own conversation.
 */
export class CodexSessionEstablishment {
  readonly #dependencies: CodexSessionEstablishmentDependencies;
  readonly #options: CodexSessionEstablishmentDependencies["options"];

  constructor(dependencies: CodexSessionEstablishmentDependencies) {
    this.#dependencies = dependencies;
    this.#options = dependencies.options;
  }

  /** Starts a fresh conversation on the account's service; a failure leaves nothing installed. */
  async establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Composed before the service is touched, so an unresolvable context costs nothing.
    const threadSettings = await this.#composeThreadSettings(params);
    const service = await this.#dependencies.services.serviceFor(params.providerAccountId);
    await service.ensureStarted();
    if (params.largerWindow !== undefined) {
      await this.#confirmLargerWindow(service, params.model, params.largerWindow);
    }
    // Before the service is asked, so a level the model does not list reaches no conversation.
    const outputSpeed = await this.#dependencies.outputSpeed.resolveLevel(
      service,
      params.model,
      params.outputSpeed,
    );
    const closeClaim = service.beginThreadClaim();
    let startedThreadId: string | undefined;
    try {
      const response = await service.request("thread/start", {
        ...composeCodexThreadParams(threadSettings, this.#options.toolServerRoute.port),
        ...composeCodexServiceTier(outputSpeed),
      });
      const thread = readThread(response, "thread/start");
      startedThreadId = thread.id;
      assertCodexThreadProfile(response, threadSettings, "thread/start");
      this.#dependencies.slots.install(
        composeSessionRecord(this.#options.diagnostics, {
          sessionId: params.sessionId,
          service,
          threadId: thread.id,
          // Named by the session's first run.
          bindingId: undefined,
          providerAccountId: params.providerAccountId,
          turnBoundaries: [],
          threadSettings,
          executionPosture: requireExecutionPosture(params),
          sessionMode: "build",
          outputSpeedRequest: params.outputSpeed,
          declaredOutputSpeed: this.#dependencies.outputSpeed.readDeclaredTier(
            params.sessionId,
            response,
          ),
          reasoningEffort: readThreadReasoningEffort(response),
        }),
      );
      // Bases at zero: the provider's counter starts there, so the first turn is real spend.
      this.#dependencies.notificationRouting.bindSessionThread(params.sessionId, thread.id, {
        mode: "fresh",
      });
      service.registerThread(thread.id, params.sessionId);
      // `id` is the resume key; `sessionId` groups a thread tree (fork and helper threads share
      // it), so the two are not interchangeable.
      return { providerSessionId: thread.sessionId, resumeHandle: thread.id };
    } catch (cause) {
      // A conversation that started under the wrong level is let go before the fault surfaces.
      if (startedThreadId !== undefined) {
        await unsubscribeCodexThreadQuietly(
          service,
          startedThreadId,
          this.#options.reportDiagnostic,
        );
      }
      throw cause;
    } finally {
      closeClaim();
    }
  }

  /**
   * Refuses a create whose larger window the service's catalog does not offer `model` at that
   * figure now, so a picker row read before the catalog changed starts no conversation. A failed
   * catalog read, or an unreadable row for the model, propagates.
   */
  async #confirmLargerWindow(
    service: CodexService,
    model: string,
    largerWindow: number,
  ): Promise<void> {
    const offeredLargerWindow = readCodexLargerWindow(await service.readModelCatalogDump(), model);
    if (offeredLargerWindow !== largerWindow) {
      throw new CodexLargerWindowUnavailableError(model, largerWindow, offeredLargerWindow);
    }
  }

  /**
   * Reopens a conversation from its handle on the account's service by forking it there with every
   * setting the session holds, since its config reaches a conversation only through a start, resume
   * or fork, and a resume of one another client holds applies none of it. The session runs on the
   * fork, which the result names; a live record the session held is superseded. Every failure
   * returns `failed`.
   */
  async establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Read inside the claimed establishment, after any predecessor installed its record.
    const existing = this.#dependencies.slots.recordFor(params.sessionId);
    let service: CodexService | undefined;
    try {
      const threadSettings = await this.#composeThreadSettings(params);
      service = await this.#dependencies.services.serviceFor(params.providerAccountId);
      await service.ensureStarted();
      const closeClaim = service.beginThreadClaim();
      try {
        const forked = await this.#dependencies.forks.forkThread(service, params.resumeHandle, {
          sessionId: params.sessionId,
          threadSettings,
          outputSpeedRequest: params.outputSpeed,
          sessionMode: params.mode,
        });
        // Built before the swap: the minter can throw, and after the install that would leave the
        // session on a conversation no binding names. Parsed because the schema is the only check
        // of the minted `bindingId` before it is persisted.
        let bindingId: string;
        let resumedResult: DriverResumeResult;
        try {
          bindingId = this.#dependencies.newBindingId();
          resumedResult = DriverResumeResultSchema.parse({
            status: "resumed",
            bindingId,
            sessionPosition: forked.turnIds.length,
            resumeHandle: forked.threadId,
          });
        } catch (cause) {
          await unsubscribeCodexThreadQuietly(
            service,
            forked.threadId,
            this.#options.reportDiagnostic,
          );
          throw cause;
        }
        if (existing !== undefined) {
          this.#releaseSuperseded(existing);
        }
        this.#dependencies.slots.install(
          composeSessionRecord(this.#options.diagnostics, {
            sessionId: params.sessionId,
            service,
            threadId: forked.threadId,
            bindingId,
            providerAccountId: params.providerAccountId,
            turnBoundaries: forked.turnIds,
            threadSettings,
            executionPosture: requireExecutionPosture(params),
            sessionMode: params.mode,
            outputSpeedRequest: params.outputSpeed,
            declaredOutputSpeed: this.#dependencies.outputSpeed.readDeclaredTier(
              params.sessionId,
              forked.response,
            ),
            reasoningEffort: readThreadReasoningEffort(forked.response),
          }),
        );
        // Based on the thread it was forked from, the only key the earlier spend exists under.
        this.#bindResumedThread(params.sessionId, forked.threadId, params.resumeHandle);
        service.registerThread(forked.threadId, params.sessionId);
        return resumedResult;
      } finally {
        closeClaim();
      }
    } catch (cause) {
      return {
        status: "failed",
        recoveryCondition:
          service === undefined
            ? "recovery-needed"
            : await classifyResumeRecoveryCondition(service, cause, this.#options.reportDiagnostic),
        providerFailureDetail: normalizeProviderFailureDetail(cause),
      };
    }
  }

  /**
   * Resumes a held record's conversation on `service` in place: after its service crashed or its
   * connection came back, or once it left the old service for a new build. The resume carries the
   * settings the record holds now, and the conversation's turns come back with the result, so a
   * caller can end the ones that ended unseen. A resume refused while another runtime still writes
   * the conversation is tried again each time `awaitWriterLeft` answers `true`. Every failure
   * returns `failed`.
   */
  async resumeInPlace(
    record: CodexSessionRecord,
    service: CodexService,
    awaitWriterLeft?: () => Promise<boolean>,
  ): Promise<CodexInPlaceResume> {
    try {
      // Asked for before the resume, so no report of it can arrive ahead of the record knowing.
      record.permissionProfiles = composeCodexThreadPermissionProfiles(record.threadSettings);
      let resumed: CodexResumedThread;
      for (;;) {
        try {
          resumed = await this.#resumeThread(service, record.threadId, record);
          break;
        } catch (cause) {
          if (
            awaitWriterLeft === undefined ||
            !isActiveWriterRefusal(cause) ||
            !(await awaitWriterLeft())
          ) {
            throw cause;
          }
        }
      }
      const bindingId = this.#dependencies.newBindingId();
      const resumedResult = DriverResumeResultSchema.parse({
        status: "resumed",
        bindingId,
        sessionPosition: resumed.listedTurns.length,
        resumeHandle: record.threadId,
      });
      record.service = service;
      record.bindingId = bindingId;
      record.turnBoundaries.splice(
        0,
        record.turnBoundaries.length,
        ...resumed.listedTurns.map((listed) => listed.id),
      );
      record.declaredOutputSpeed = resumed.declaredOutputSpeed;
      record.reasoningEffort = resumed.reasoningEffort;
      await updateCodexSessionMode(record, record.sessionMode);
      this.#bindResumedThread(record.sessionId, record.threadId, record.threadId);
      return { result: resumedResult, listedTurns: resumed.listedTurns };
    } catch (cause) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "conversation-resume-failed",
        threadId: record.threadId,
        detail: normalizeProviderFailureDetail(cause),
      });
      return {
        result: {
          status: "failed",
          recoveryCondition: await classifyResumeRecoveryCondition(
            service,
            cause,
            this.#options.reportDiagnostic,
          ),
          providerFailureDetail: normalizeProviderFailureDetail(cause),
        },
        listedTurns: [],
      };
    }
  }

  /**
   * The settings a session's conversation runs with, resolved afresh at every start and resume,
   * with its helpers' role files written again. Throws `CodexDriverConfigError` with no posture,
   * since every conversation runs at a level, and for a helper no role file can carry.
   */
  async #composeThreadSettings(
    params: CreateSessionParams | ResumeSessionParams,
  ): Promise<CodexThreadSettings> {
    const posture = requireExecutionPosture(params);
    const context = await this.#options.spawnContext.resolveSpawnContext(
      params.sessionId,
      params.providerAccountId,
    );
    const credentialPolicy = await this.#options.credentialPolicy.resolveCredentialPolicy(
      posture.credentialPolicyRef,
    );
    const definitions =
      params.subagentPolicy?.enabled === true ? params.subagentPolicy.definitions : [];
    const helperRoles = await writeCodexHelperRoles(
      this.#options.helperRolesFolder,
      params.sessionId,
      definitions,
    );
    this.#reportWithheldDefinitionFields(definitions);
    return {
      sessionId: params.sessionId,
      workingDirectory: context.workingDirectory,
      model: params.model,
      // A resume sends the recorded figure whatever the catalog offers now; Codex refuses one it
      // cannot run, and that failure surfaces like any other.
      modelContextWindow: params.largerWindow,
      level: posture.mode,
      profileFolders: {
        workingDirectory: context.workingDirectory,
        gitCommonFolder: context.gitCommonFolder,
        writableRoots: posture.writableRoots,
        denyPaths: credentialPolicy.denyPaths,
      },
      shellEnvironment: composeCodexShellEnvironmentPolicy({
        baseEnv: this.#options.providerBaseEnvironment,
        environmentRows: context.environmentRows,
        hostEnvNameMatch: this.#options.operatingSystem.environmentNameMatch,
      }),
      subagentPolicy: params.subagentPolicy,
      helperRoles,
      toolServers: params.toolServers ?? [],
      baseInstructions: context.baseInstructions,
    };
  }

  /** `thread/resume` with every setting, then the turn history read back page by page. */
  async #resumeThread(
    service: CodexService,
    threadId: string,
    session: Pick<CodexSessionRecord, "sessionId" | "threadSettings" | "outputSpeedRequest">,
  ): Promise<CodexResumedThread> {
    // The level rebuilt from the record; one the model no longer lists resumes at standard.
    const outputSpeed = await this.#dependencies.outputSpeed.resolveLevel(
      service,
      session.threadSettings.model,
      session.outputSpeedRequest,
    );
    const closeClaim = service.beginThreadClaim();
    try {
      const response = await service.request("thread/resume", {
        threadId,
        // The history is paged afterwards instead of arriving on one reply.
        excludeTurns: true,
        ...composeCodexThreadParams(session.threadSettings, this.#options.toolServerRoute.port),
        ...composeCodexServiceTier(outputSpeed),
      });
      const thread = readThread(response, "thread/resume");
      // Codex may answer an unhonorable resume with a different thread.
      if (thread.id !== threadId) {
        throw new CodexTransportError(
          `Resume handle ${threadId} was answered by thread ${thread.id}; the provider started a ` +
            `replacement conversation rather than resuming.`,
          { method: "thread/resume", requestedThreadId: threadId, answeredThreadId: thread.id },
        );
      }
      assertCodexThreadProfile(response, session.threadSettings, "thread/resume");
      const wasHeld = service.threads.sessionFor(threadId) === session.sessionId;
      // Registered before the history read, so the thread's frames reach the session from now.
      service.registerThread(threadId, session.sessionId);
      try {
        return {
          listedTurns: await readCodexTurns(service, threadId),
          declaredOutputSpeed: this.#dependencies.outputSpeed.readDeclaredTier(
            session.sessionId,
            response,
          ),
          reasoningEffort: readThreadReasoningEffort(response),
        };
      } catch (cause) {
        if (!wasHeld) {
          service.threads.release(threadId);
        }
        throw cause;
      }
    } finally {
      closeClaim();
    }
  }

  /**
   * Lets a superseded record go: the runs its turns held fail, since no terminal can end them
   * now, their routes and waits are swept, and its conversation, which the session no longer runs
   * on, is let go once no command of it runs.
   */
  #releaseSuperseded(superseded: CodexSessionRecord): void {
    this.#failLostRuns(superseded);
    this.#dependencies.pendingCompactions.releaseBinding(
      codexCompactionWaitKey(superseded.sessionId, superseded.threadId),
    );
    this.#dependencies.runRoutes.forgetRunRoutes(superseded.sessionId);
    superseded.runIdByActiveTurnId.clear();
    superseded.interruptedRunIdByTurnId.clear();
    superseded.pauseRunIdByTurnId.clear();
    superseded.pausedRunIdByInterruptedTurnId.clear();
    superseded.continuesAwaitingPause.clear();
    // Its helpers' threads too; the release holds its own thread while a command of it runs.
    this.#dependencies.release.releaseSessionThreads(superseded.service, superseded.sessionId);
    void this.#dependencies.release.letGo(
      superseded.service,
      superseded.threadId,
      superseded.sessionId,
    );
  }

  // `priorEmittedThreadId` is the thread the earlier spend was emitted under: the same one for a
  // resume in place, the source of a fork.
  #bindResumedThread(sessionId: SessionId, threadId: string, priorEmittedThreadId: string): void {
    // The held enumeration was read before the resume; a fresh read follows the next request.
    this.#dependencies.providerCommands.discardProviderCommandEnumeration(sessionId);
    // Bases at the daemon's prior-emitted sum: the provider's counter survives a resume, so a
    // zero base would re-meter the whole history onto the first turn.
    this.#dependencies.notificationRouting.bindSessionThread(sessionId, threadId, {
      mode: "resume",
      priorEmittedThreadId,
    });
  }

  /**
   * Fails each run once whose turn a lost record still held, live or interrupted with its
   * terminal still owed. A throwing consumer is recorded and the remaining runs still reported.
   */
  #failLostRuns(lost: CodexSessionRecord): void {
    const runIds = new Set<RunId>([
      ...lost.runIdByActiveTurnId.values(),
      ...lost.interruptedRunIdByTurnId.values(),
    ]);
    const failure = composeSupersededRunFailure();
    for (const runId of runIds) {
      try {
        this.#options.onLostRunFailure(lost.sessionId, runId, failure);
      } catch (cause) {
        this.#options.diagnostics.emit({
          provider: CODEX_DRIVER_NAME,
          kind: "superseded_run_report_failed",
          rawWireType: null,
          dispositionReason: normalizeProviderFailureDetail(cause),
          details: {
            sessionId: lost.sessionId,
            runId,
            providerFailureDetail: failure.providerFailureDetail,
          },
        });
      }
    }
  }

  /**
   * Records each field of a helper definition its role file cannot carry, the tool list and the
   * turn cap, so the helper is known to run without it.
   */
  #reportWithheldDefinitionFields(definitions: readonly SubagentDefinition[]): void {
    for (const definition of definitions) {
      for (const field of readCodexRoleFileWithheldFields(definition)) {
        const reason =
          `a Codex role file has no place for the helper's ${field}, so the helper runs ` +
          `without it`;
        reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
          kind: "subagent-definition-field-withheld",
          definitionName: definition.name,
          field,
        });
        this.#options.diagnostics.emit({
          provider: CODEX_DRIVER_NAME,
          kind: "subagent_definition_field_withheld",
          rawWireType: null,
          dispositionReason: reason,
          // Untrusted caller-supplied text, carried verbatim as data.
          details: { definitionName: definition.name, field },
        });
      }
    }
  }
}

/**
 * The session's posture. Throws `CodexDriverConfigError` with none: every conversation runs at a
 * level.
 */
function requireExecutionPosture(
  params: CreateSessionParams | ResumeSessionParams,
): ExecutionPosture {
  if (params.executionPosture === undefined) {
    throw new CodexDriverConfigError(
      "A Codex conversation always runs at a permission level, so the session needs an " +
        "execution posture.",
      "executionPosture",
    );
  }
  return params.executionPosture;
}

/** The run terminal for a run whose turn a resume superseded before Codex settled it. */
function composeSupersededRunFailure(): CodexLostRunFailure {
  return {
    eventType: "run.failed",
    failureCategory: "provider failure",
    recoveryCondition: "recovery-needed",
    providerFailureDetail:
      "The runtime binding carrying a user's text for this run was superseded by a resume " +
      "before the provider settled the turn, so whether those words reached the model was " +
      "never established.",
  };
}
