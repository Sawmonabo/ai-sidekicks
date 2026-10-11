// A session's provider session, opened by its first admission: the driver's `createSession` and
// the runtime binding that records it, or, when the session already has a conversation from before
// the daemon started, the driver's `resumeSession` of it and the binding the resume minted. Each
// run after that gets a binding of its own on the session's current leg. A session's opening, its
// run bindings and its level moves take one lock, so a process never opens at a level a move is
// about to replace, and two moves never store one level while the process runs at the other.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type {
  PermissionLevel,
  SessionMode,
} from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import { KeyedLock } from "../keyed-lock.js";
import { composeExecutionPosture } from "../policy/execution-posture-service.js";
import type { CreateSessionParams, ProviderDriver } from "../provider/driver/contract.js";
import {
  composeResumeSessionParams,
  type ResumeFunctionLegInjection,
  type RuntimeBinding,
  type RuntimeBindingSpawnConfig,
  type RuntimeBindingStore,
} from "../provider/runtime-binding-store.js";
import type { RunBindingCursors } from "../session/run/binding-cursors.js";

/** What a session's provider session opens with, composed from the session's lead. */
export interface ProviderSessionOpening {
  readonly driverName: ProviderName;
  /** The git folder of the session's repository, which the posture of each level is built on. */
  readonly gitFolder: string;
  /**
   * The create's data legs, its posture the one of the level the session stands at; the function
   * legs are bound to the binding once it is minted.
   */
  readonly createParams: Omit<CreateSessionParams, "onCallbackToolCall" | "onMcpServerStatus">;
  /** The callbacks a process of the leg `bindingId` is handed, bound to that leg. */
  readonly functionLegsFor: (bindingId: string) => ResumeFunctionLegInjection;
}

/** What the session opener reads and calls. */
export interface ProviderSessionsDeps {
  /** The binding rows a session's opening completes or removes. */
  readonly runtimeBindings: Pick<RuntimeBindingStore, "update" | "delete">;
  /** Records each binding a run opens on, or a resume minted, with its epoch cursor open. */
  readonly bindingCursors: Pick<RunBindingCursors, "create" | "recordRelaunch">;
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
  /** The level the session stands at, which a resumed conversation starts at. */
  readonly readPermissionLevel: (sessionId: SessionId) => PermissionLevel;
  /** Stores the level the session moved to. */
  readonly recordPermissionLevel: (sessionId: SessionId, level: PermissionLevel) => Promise<void>;
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

// One opened session: the posture its process runs at, which each of its runs is requested at, and
// the git folder each level's posture is built on.
interface OpenedSession {
  executionPosture: ExecutionPosture;
  readonly gitFolder: string;
}

/**
 * Opens each session's provider session once per daemon process, at its first admission, and the
 * runtime binding of each run on it. A session holds one entry from its first admission until it
 * closes or the daemon stops.
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
   * one's, else the one it opens at. Throws {@link ProviderSessionOpenError} for a session with no
   * posture.
   */
  async readExecutionPosture(sessionId: SessionId): Promise<ExecutionPosture> {
    const opened = this.#opened.get(canonicalizeUuid(sessionId));
    if (opened !== undefined) {
      return opened.executionPosture;
    }
    return postureOf(sessionId, await this.#deps.composeOpening(sessionId));
  }

  /**
   * Moves the session to `level` and stores it, unless it stands there already. An open process
   * is moved first, by `moveProcess` to the level's posture, so the record never names a level the
   * provider refused; a store that fails then moves it back and throws. A process not open yet
   * opens at the stored level. Throws what `moveProcess` throws, with nothing changed.
   */
  async changeLevel(
    sessionId: SessionId,
    level: PermissionLevel,
    moveProcess: (posture: ExecutionPosture) => Promise<void>,
  ): Promise<void> {
    await this.#openLock.run(sessionId, async () => {
      if (this.#deps.readPermissionLevel(sessionId) === level) {
        return;
      }
      const opened = this.#opened.get(canonicalizeUuid(sessionId));
      if (opened === undefined) {
        await this.#deps.recordPermissionLevel(sessionId, level);
        return;
      }
      const postureBefore = opened.executionPosture;
      const posture = composeExecutionPosture(level, opened.gitFolder);
      await moveProcess(posture);
      opened.executionPosture = posture;
      try {
        await this.#deps.recordPermissionLevel(sessionId, level);
      } catch (recordError) {
        try {
          await moveProcess(postureBefore);
          opened.executionPosture = postureBefore;
        } catch (moveBackError) {
          throw new AggregateError(
            [recordError, moveBackError],
            `Session ${sessionId}'s level was not stored, and its process could not move back`,
            { cause: moveBackError },
          );
        }
        throw recordError;
      }
    });
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
   * The binding `runId` runs on: the session's current leg, its newest binding with a conversation,
   * recorded again for the run, unless the run is the one that leg is on. Throws when the session
   * was not opened in this process or has no conversation.
   */
  async openRunBinding(runId: RunId, sessionId: SessionId): Promise<string> {
    return this.#openLock.run(sessionId, async () => {
      const opened = this.#opened.get(canonicalizeUuid(sessionId));
      if (opened === undefined) {
        throw new ProviderSessionOpenError(sessionId, "it has no provider session open");
      }
      // Read afresh: a fork moves the leg onto another conversation and a relaunch records a new
      // leg, so the newest one is the session's.
      const current = this.#deps.readSessionLeg(sessionId);
      if (current === undefined) {
        throw new ProviderSessionOpenError(sessionId, "it has no conversation to run on");
      }
      if (current.runId === runId) {
        return current.id;
      }
      const binding = await this.#deps.bindingCursors.create({
        runId,
        driverName: current.driverName,
        contractVersion: current.contractVersion,
        ...(current.cliVersion === null ? {} : { cliVersion: current.cliVersion }),
        resumeHandle: current.resumeHandle,
        spawnConfig: current.spawnConfig,
      });
      return binding.id;
    });
  }

  /** Forgets a closed session's provider session, whose process its close ended. */
  forget(sessionId: SessionId): void {
    this.#opened.delete(canonicalizeUuid(sessionId));
  }

  async #create(sessionId: SessionId, runId: RunId): Promise<OpenedSession> {
    const opening = await this.#deps.composeOpening(sessionId);
    const { driverName, createParams } = opening;
    const executionPosture = postureOf(sessionId, opening);
    const binding = await this.#deps.bindingCursors.create({
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
    return { executionPosture, gitFolder: opening.gitFolder };
  }

  // The session ran before this daemon started: its conversation is resumed in a fresh process,
  // and the binding the resume minted is the run's.
  async #resume(sessionId: SessionId, leg: RuntimeBinding, runId: RunId): Promise<OpenedSession> {
    const opening = await this.#deps.composeOpening(sessionId);
    const executionPosture = postureOf(sessionId, opening);
    const params = composeResumeSessionParams(
      sessionId,
      leg,
      opening.createParams.model,
      opening.createParams.largerWindow,
      this.#deps.readSessionMode(sessionId),
      executionPosture,
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
    await this.#deps.bindingCursors.recordRelaunch({
      predecessorId: leg.id,
      bindingId: result.bindingId,
      resumeHandle: result.resumeHandle,
      leftConversations,
    });
    const session: OpenedSession = { executionPosture, gitFolder: opening.gitFolder };
    // The resumed leg sits on the run it was first opened for; this run gets its own.
    this.#opened.set(canonicalizeUuid(sessionId), session);
    await this.openRunBinding(runId, sessionId);
    return session;
  }
}

// The posture a session's process opens or resumes at, the one its opening names.
function postureOf(sessionId: SessionId, opening: ProviderSessionOpening): ExecutionPosture {
  const posture = opening.createParams.executionPosture;
  if (posture === undefined) {
    throw new ProviderSessionOpenError(sessionId, "its lead runs at no posture");
  }
  return posture;
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
