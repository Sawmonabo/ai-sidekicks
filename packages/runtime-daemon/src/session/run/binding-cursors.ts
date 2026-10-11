// The epoch cursor of each run's runtime binding. It opens as the binding is recorded, at the
// start every run opens at, and drops once its run has ended and the session has recorded a newer
// binding, or the session closed, so the provider's last deliveries on an ended run still find it
// and are absorbed as late, and a session holds the cursors of its newest bindings alone. A binding
// a driver mints when it resumes a session in a new process carries its predecessor's cursor on,
// opened before its row is written, since the resumed provider delivers under it at once.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { RUN_START_POSITION } from "@ai-sidekicks/contracts/transcript/turn-attribution";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type {
  CreateRuntimeBindingInput,
  RuntimeBinding,
  RuntimeBindingRelaunch,
  RuntimeBindingStore,
} from "../../provider/runtime-binding-store.js";
import type { EpochBinding, ExecutionEpochs } from "./epochs.js";
import type { RunStateReader } from "./read.js";
import { readStoredRunStateChange } from "./stored-state-change.js";
import { isTerminalState } from "./transitions.js";

const SESSION_CLOSED_TYPE = "session.closed";

/** A binding of one run to record, its run named by the run's own id. */
export type RunBindingInput = CreateRuntimeBindingInput & { readonly runId: RunId };

/** What the cursors are kept over. */
export interface RunBindingCursorsDeps {
  readonly store: Pick<RuntimeBindingStore, "create" | "findById" | "recordRelaunch">;
  readonly epochs: Pick<ExecutionEpochs, "openBinding" | "continueBinding" | "closeBinding">;
  readonly runs: Pick<RunStateReader, "getRun">;
}

// One session's bindings with a cursor open, and the ended runs whose cursors wait to drop.
interface SessionCursors {
  readonly bindingIdsByRun: Map<RunId, string[]>;
  readonly endedRunIds: Set<RunId>;
}

/** Records each run's binding with its epoch cursor open, and drops the cursors runs left. */
export class RunBindingCursors {
  readonly #deps: RunBindingCursorsDeps;
  readonly #sessions = new Map<SessionId, SessionCursors>();

  constructor(deps: RunBindingCursorsDeps) {
    this.#deps = deps;
  }

  /**
   * Records a binding of a run in the store and opens its cursor at the run's start, dropping the
   * cursors of the session's runs that have ended. Throws for a run no session holds, recording
   * nothing, and what the store throws.
   */
  async create(input: RunBindingInput): Promise<RuntimeBinding> {
    const run = this.#deps.runs.getRun(input.runId);
    if (run === undefined) {
      throw new Error(`Run ${input.runId} is held by no session, so no binding is recorded for it`);
    }
    const binding = await this.#deps.store.create(input);
    const session = this.#sessionOf(run.sessionId);
    for (const endedRunId of session.endedRunIds) {
      this.#drop(session, endedRunId);
    }
    session.endedRunIds.clear();
    this.#deps.epochs.openBinding(binding, RUN_START_POSITION);
    this.#hold(session, input.runId, binding.id);
    return binding;
  }

  /**
   * Opens the cursor of `bindingId`, which a driver minted when it resumed `predecessor`'s
   * conversation in a new process, on `predecessor`'s run, where `predecessor`'s cursor stands.
   * Throws for a run no session holds and for a binding that already has a cursor.
   */
  continueBinding(predecessor: EpochBinding, bindingId: string): void {
    // The stored binding names its run as text.
    const runId = RunIdSchema.parse(predecessor.runId);
    const run = this.#deps.runs.getRun(runId);
    if (run === undefined) {
      throw new Error(
        `Run ${runId} is held by no session, so binding ${bindingId} opens no cursor`,
      );
    }
    this.#deps.epochs.continueBinding(
      { id: bindingId, runId, driverName: predecessor.driverName },
      predecessor.id,
      RUN_START_POSITION,
    );
    const session = this.#sessionOf(run.sessionId);
    this.#hold(session, runId, bindingId);
    // A leg resumed on a run that has already ended drops at the session's next binding.
    if (isTerminalState(run.state)) {
      session.endedRunIds.add(runId);
    }
  }

  /**
   * Records the binding a resume minted, with its cursor opened first by {@link continueBinding}.
   * Throws for a predecessor the store does not hold, recording nothing, and what the store throws.
   */
  async recordRelaunch(relaunch: RuntimeBindingRelaunch): Promise<void> {
    const predecessor = this.#deps.store.findById(relaunch.predecessorId);
    if (predecessor === undefined) {
      throw new Error(`The runtime binding ${relaunch.predecessorId} has no row to resume from`);
    }
    this.continueBinding(predecessor, relaunch.bindingId);
    await this.#deps.store.recordRelaunch(relaunch);
  }

  /** Takes a committed session event: a run's end marks its cursors to drop; a close drops all. */
  observe(event: EventEnvelope): void {
    const key = canonicalizeUuid(event.sessionId);
    const session = this.#sessions.get(key);
    if (session === undefined) {
      return;
    }
    if (event.type === SESSION_CLOSED_TYPE) {
      for (const runId of [...session.bindingIdsByRun.keys()]) {
        this.#drop(session, runId);
      }
      this.#sessions.delete(key);
      return;
    }
    const change = readStoredRunStateChange(event);
    if (
      change !== undefined &&
      isTerminalState(change.newState) &&
      session.bindingIdsByRun.has(change.runId)
    ) {
      session.endedRunIds.add(change.runId);
    }
  }

  #sessionOf(sessionId: SessionId): SessionCursors {
    const key = canonicalizeUuid(sessionId);
    const session = this.#sessions.get(key) ?? {
      bindingIdsByRun: new Map(),
      endedRunIds: new Set(),
    };
    this.#sessions.set(key, session);
    return session;
  }

  #hold(session: SessionCursors, runId: RunId, bindingId: string): void {
    session.bindingIdsByRun.set(runId, [...(session.bindingIdsByRun.get(runId) ?? []), bindingId]);
  }

  #drop(session: SessionCursors, runId: RunId): void {
    for (const bindingId of session.bindingIdsByRun.get(runId) ?? []) {
      this.#deps.epochs.closeBinding(bindingId);
    }
    session.bindingIdsByRun.delete(runId);
  }
}

/**
 * The binding store a run's bindings are opened through: `store` itself, with each binding it
 * records or a resume minted opened with its cursor by `cursors`.
 */
export function bindingStoreWithCursors(
  store: Pick<RuntimeBindingStore, "update" | "delete" | "findById">,
  cursors: Pick<RunBindingCursors, "create" | "recordRelaunch">,
): Pick<RuntimeBindingStore, "update" | "delete" | "findById"> &
  Pick<RunBindingCursors, "create" | "recordRelaunch"> {
  return {
    create: async (input) => await cursors.create(input),
    update: async (id, patch, leftConversations) =>
      await store.update(id, patch, leftConversations),
    delete: async (id) => await store.delete(id),
    findById: (id) => store.findById(id),
    recordRelaunch: async (relaunch) => {
      await cursors.recordRelaunch(relaunch);
    },
  };
}
