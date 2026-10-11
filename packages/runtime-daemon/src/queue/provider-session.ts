// A session's provider session, opened by its first admission: the driver's `createSession` and
// the runtime binding that records it, or, when the session already has a conversation from before
// the daemon started, the driver's `resumeSession` of it and the binding the resume minted. Each
// run after that gets a binding of its own on the session's current leg.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import { KeyedLock } from "../keyed-lock.js";
import type { CreateSessionParams, ProviderDriver } from "../provider/driver/contract.js";
import {
  composeResumeSessionParams,
  type ResumeFunctionLegInjection,
  type RuntimeBinding,
  type RuntimeBindingSpawnConfig,
  type RuntimeBindingStore,
} from "../provider/runtime-binding-store.js";

/** What a session's provider session opens with, composed from the session's lead. */
export interface ProviderSessionOpening {
  readonly driverName: ProviderName;
  /** The create's data legs; the function legs are bound to the binding once it is minted. */
  readonly createParams: Omit<CreateSessionParams, "onCallbackToolCall" | "onMcpServerStatus">;
  /** The callbacks a process of the leg `bindingId` is handed, bound to that leg. */
  readonly functionLegsFor: (bindingId: string) => ResumeFunctionLegInjection;
}

/** What the session opener reads and calls. */
export interface ProviderSessionsDeps {
  readonly runtimeBindings: Pick<
    RuntimeBindingStore,
    "create" | "update" | "delete" | "findById" | "recordRelaunch"
  >;
  readonly resolveDriver: (
    driverName: ProviderName,
  ) => Pick<ProviderDriver, "createSession" | "resumeSession">;
  /** The contract version the driver declares, which every binding it runs on records. */
  readonly readContractVersion: (driverName: ProviderName) => string;
  /** Composes the session's opening from its lead as its log stands now. */
  readonly composeOpening: (sessionId: SessionId) => Promise<ProviderSessionOpening>;
  /** The session's newest binding with a conversation to resume, or `undefined` for none. */
  readonly readSessionLeg: (sessionId: SessionId) => RuntimeBinding | undefined;
  readonly readSessionMode: (sessionId: SessionId) => SessionMode;
}

/** Thrown when a session's provider session could not be opened; nothing of it is left live. */
class ProviderSessionOpenError extends Error {
  readonly sessionId: SessionId;

  constructor(sessionId: SessionId, detail: string, options?: ErrorOptions) {
    super(`The provider session of session ${sessionId} could not be opened: ${detail}`, options);
    this.name = "ProviderSessionOpenError";
    this.sessionId = sessionId;
  }
}

// One opened session: the posture its process runs at, which each of its runs is requested at,
// and the binding its newest run is on.
interface OpenedSession {
  readonly executionPosture: ExecutionPosture;
  bindingId: string;
}

/**
 * Opens each session's provider session once per daemon process, at its first admission, and the
 * runtime binding of each run on it. A session holds one entry from its first admission until the
 * daemon stops.
 */
export class ProviderSessions {
  readonly #deps: ProviderSessionsDeps;
  readonly #opened = new Map<SessionId, OpenedSession>();
  // One open per session at a time; a session id spelled in either hex case takes one lock.
  readonly #openLock = new KeyedLock<SessionId>(canonicalizeUuid);

  constructor(deps: ProviderSessionsDeps) {
    this.#deps = deps;
  }

  /**
   * The posture the session's process runs at, which each of its runs is requested at: the open
   * one's, else the conversation's it resumes, else the one it opens with. Throws
   * {@link ProviderSessionOpenError} for a session with no posture.
   */
  async readExecutionPosture(sessionId: SessionId): Promise<ExecutionPosture> {
    const opened = this.#opened.get(canonicalizeUuid(sessionId));
    if (opened !== undefined) {
      return opened.executionPosture;
    }
    return postureOf(
      sessionId,
      this.#deps.readSessionLeg(sessionId),
      await this.#deps.composeOpening(sessionId),
    );
  }

  /**
   * Opens the session's provider session for `runId`, its first admitted run, when this process
   * has not opened it: resumed from the session's newest conversation where it has one, else
   * created, with the binding `runId` runs on. Throws {@link ProviderSessionOpenError} for a resume
   * the provider refused or a session with no posture, and what the driver's create threw, with no
   * binding left for a create that failed.
   */
  async open(sessionId: SessionId, runId: RunId): Promise<void> {
    await this.#openLock.run(sessionId, async () => {
      if (this.#opened.has(canonicalizeUuid(sessionId))) {
        return;
      }
      const leg = this.#deps.readSessionLeg(sessionId);
      const session =
        leg === undefined
          ? await this.#create(sessionId, runId)
          : await this.#resume(sessionId, leg, runId);
      this.#opened.set(canonicalizeUuid(sessionId), session);
    });
  }

  /**
   * The binding `runId` runs on: the session's current leg recorded again for the run, unless the
   * run is the one the leg was opened for. Throws when the session was not opened in this process.
   */
  async openRunBinding(runId: RunId, sessionId: SessionId): Promise<string> {
    return this.#openLock.run(sessionId, async () => {
      const opened = this.#opened.get(canonicalizeUuid(sessionId));
      if (opened === undefined) {
        throw new ProviderSessionOpenError(sessionId, "it has no provider session open");
      }
      // Read afresh: a fork or a relaunch may have pointed the leg at another conversation.
      const current = this.#deps.runtimeBindings.findById(opened.bindingId);
      if (current === undefined) {
        throw new ProviderSessionOpenError(sessionId, `its binding ${opened.bindingId} is gone`);
      }
      if (current.runId === runId) {
        return current.id;
      }
      const binding = await this.#deps.runtimeBindings.create({
        runId,
        driverName: current.driverName,
        contractVersion: current.contractVersion,
        ...(current.cliVersion === null ? {} : { cliVersion: current.cliVersion }),
        resumeHandle: current.resumeHandle,
        spawnConfig: current.spawnConfig,
      });
      opened.bindingId = binding.id;
      return binding.id;
    });
  }

  async #create(sessionId: SessionId, runId: RunId): Promise<OpenedSession> {
    const opening = await this.#deps.composeOpening(sessionId);
    const { driverName, createParams } = opening;
    const executionPosture = postureOf(sessionId, undefined, opening);
    const binding = await this.#deps.runtimeBindings.create({
      runId,
      driverName,
      contractVersion: this.#deps.readContractVersion(driverName),
      spawnConfig: spawnConfigOf(createParams),
    });
    let resumeHandle: string;
    try {
      ({ resumeHandle } = await this.#deps.resolveDriver(driverName).createSession({
        ...createParams,
        ...opening.functionLegsFor(binding.id),
      }));
    } catch (createError) {
      // A run whose session never opened keeps no binding.
      try {
        await this.#deps.runtimeBindings.delete(binding.id);
      } catch (deleteError) {
        throw new AggregateError(
          [createError, deleteError],
          `The provider session of session ${sessionId} was not created, and its binding ` +
            `${binding.id} could not be removed`,
          { cause: deleteError },
        );
      }
      throw createError;
    }
    const recorded = await this.#deps.runtimeBindings.update(binding.id, { resumeHandle });
    if (recorded === undefined) {
      throw new ProviderSessionOpenError(sessionId, `its binding ${binding.id} is gone`);
    }
    return { executionPosture, bindingId: binding.id };
  }

  // The session ran before this daemon started: its conversation is resumed in a fresh process,
  // and the binding the resume minted is the run's.
  async #resume(sessionId: SessionId, leg: RuntimeBinding, runId: RunId): Promise<OpenedSession> {
    const opening = await this.#deps.composeOpening(sessionId);
    const executionPosture = postureOf(sessionId, leg, opening);
    const params = composeResumeSessionParams(
      sessionId,
      leg,
      opening.createParams.model,
      opening.createParams.largerWindow,
      this.#deps.readSessionMode(sessionId),
      opening.functionLegsFor(leg.id),
    );
    const result = await this.#deps.resolveDriver(leg.driverName).resumeSession(params);
    if (result.status === "failed") {
      throw new ProviderSessionOpenError(
        sessionId,
        `${result.recoveryCondition}: ${result.providerFailureDetail}`,
      );
    }
    // A provider that continued the conversation in a new one left the old one behind.
    const leftConversations =
      leg.resumeHandle === null || leg.resumeHandle === result.resumeHandle
        ? []
        : [
            {
              sessionId,
              providerAccountId: leg.spawnConfig.providerAccountId,
              conversationId: leg.resumeHandle,
            },
          ];
    await this.#deps.runtimeBindings.recordRelaunch({
      predecessorId: leg.id,
      bindingId: result.bindingId,
      resumeHandle: result.resumeHandle,
      leftConversations,
    });
    const session: OpenedSession = { executionPosture, bindingId: result.bindingId };
    // The resumed leg sits on the run it was first opened for; this run gets its own.
    this.#opened.set(canonicalizeUuid(sessionId), session);
    await this.openRunBinding(runId, sessionId);
    return session;
  }
}

// The posture a session's process runs at: the one its resumed conversation records, else the one
// its opening names.
function postureOf(
  sessionId: SessionId,
  leg: RuntimeBinding | undefined,
  opening: ProviderSessionOpening,
): ExecutionPosture {
  if (leg !== undefined) {
    const recorded = leg.spawnConfig.executionPosture;
    if (recorded === undefined) {
      throw new ProviderSessionOpenError(sessionId, `its binding ${leg.id} records no posture`);
    }
    return recorded;
  }
  const opened = opening.createParams.executionPosture;
  if (opened === undefined) {
    throw new ProviderSessionOpenError(sessionId, "its lead runs at no posture");
  }
  return opened;
}

// The spawn-bound legs a resume rebuilds the session from.
function spawnConfigOf(params: ProviderSessionOpening["createParams"]): RuntimeBindingSpawnConfig {
  return {
    executionPosture: params.executionPosture,
    callbackTools: params.callbackTools,
    subagentPolicy: params.subagentPolicy,
    toolServers: params.toolServers,
    outputSchema: params.outputSchema,
    providerAccountId: params.providerAccountId,
    outputSpeed: params.outputSpeed,
  };
}
