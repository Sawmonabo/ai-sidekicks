// What the agent library holds: the registry read, the delete in flight, and which record the
// editor is open on. One class because the three move together: an applied delete clears the
// row, re-reads, and closes an editor open on that record. A delete the daemon rejects gives its
// lock back and leaves the row in place with the daemon's refusal drawn on it.

import { type Clock } from "@renderer/lib/clock.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/store/reads/read-triggers.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { ListAgentDefinitions } from "../agent-reads.js";
import { readDefinitions, type AgentDefinitionReading } from "./definition-rows.js";

/** Deletes one saved definition. Rejects when the daemon refuses. */
export type DeleteAgentDefinition = (request: {
  readonly definitionId: string;
}) => Promise<unknown>;

/** The registry calls the view drives. Held stable by the caller. */
export interface AgentRegistryCalls {
  readonly listDefinitions: ListAgentDefinitions;
  readonly deleteDefinition: DeleteAgentDefinition;
}

/**
 * Which record the editor is open on: a stored definition (by id, never by its mutable name) or
 * a new one. Two arms because editing and composing use different daemon verbs.
 */
export type AgentDefinitionEditorSubject =
  | { readonly kind: "stored"; readonly definitionId: string }
  | { readonly kind: "new" };

/** Everything the page renders from, in one value. */
export interface AgentLibrarySnapshot {
  readonly reading: AgentDefinitionReading;
  /** The row whose delete has been asked but not confirmed. One at a time. */
  readonly armedDeletionId: string | undefined;
  readonly deletingId: string | undefined;
  /** The view's own refusal per row, dropped when that row is attempted again. */
  readonly refusalByDefinitionId: ReadonlyMap<string, Refusal>;
  readonly editorSubject: AgentDefinitionEditorSubject | undefined;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_READ: AgentLibrarySnapshot = {
  reading: { kind: "not-loaded" },
  armedDeletionId: undefined,
  deletingId: undefined,
  refusalByDefinitionId: new Map(),
  editorSubject: undefined,
  revision: 0,
};

/** The subsystem name the refusals this view raises on its own carry. */
export const AGENT_LIBRARY_REFUSAL_ORIGIN = "agent-registry-view";

/** The one key a registry read is taken under; a refresh supersedes whoever holds it. */
const REGISTRY_READ_KEY = "registry-read";

/**
 * Holds the registry read, the delete lock and the editor subject behind one snapshot.
 *
 * The read has a latch key and the delete has a lock, kept apart: a delete pressed while the
 * first read is in flight must not discard that read's reply. A re-read supersedes an older
 * one; a delete does not, and a second confirm while one runs is refused. Under supersession
 * the second delete's settlement would win and skip the first's re-read, leaving a removed
 * record on screen. `deletingId` is both the lock and the record of which delete is running.
 */
export class AgentLibraryView implements ReadTriggerTarget {
  /**
   * No terminal event refreshes this read: the registry is node-local and nothing on the
   * session stream announces a change to it. Window triggers are the whole refresh story.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #calls: AgentRegistryCalls;
  readonly #changes = new Emitter<AgentLibrarySnapshot>("agent registry change");
  #snapshot: AgentLibrarySnapshot = NOTHING_READ;
  #hasStarted = false;
  #isDisposed = false;
  /** The latest read wins; the key is given back on settlement. */
  readonly #reads = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;

  public constructor(clock: Clock, calls: AgentRegistryCalls) {
    this.#calls = calls;
    this.#scheduler = new RefreshScheduler({
      clock,
      perform: async () => {
        await this.#read();
      },
    });
  }

  public snapshot(): AgentLibrarySnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Read the registry on mount. Idempotent: strict mode mounts an effect twice. */
  public start(): void {
    if (this.#hasStarted) {
      return;
    }
    this.#hasStarted = true;
    this.requestRead("subscribe");
  }

  /**
   * Ask for a read. `subscribe` on mount and `window-focus` on return reach a registry that
   * emits nothing: a definition made by another window or the CLI is invisible until one fires.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#reads.supersedeAll();
  }

  /** Ask the question. Arming a second row drops the first, so only one is open. */
  public armDeletion(definitionId: string): void {
    this.#publish({ armedDeletionId: definitionId });
  }

  public cancelDeletion(): void {
    this.#publish({ armedDeletionId: undefined });
  }

  public openEditor(subject: AgentDefinitionEditorSubject): void {
    this.#publish({ editorSubject: subject });
  }

  /** Drop one row's refusal — the dismiss a person presses on the notice. */
  public dismissRefusal(definitionId: string): void {
    if (this.#snapshot.refusalByDefinitionId.has(definitionId)) {
      this.#publish({ refusalByDefinitionId: this.#refusalsWithout(definitionId) });
    }
  }

  /**
   * Delete one record, then re-read rather than dropping a local copy, so the screen shows
   * the registry's answer. A second press while one delete runs gets a refusal on its row
   * instead of silence, since the page already disables the controls. A rejected delete
   * settles to the daemon's refusal on that row, so the returned promise never rejects.
   */
  public async confirmDeletion(definitionId: string): Promise<void> {
    const runningDefinitionId = this.#snapshot.deletingId;
    if (runningDefinitionId !== undefined) {
      this.#publish({
        armedDeletionId: undefined,
        refusalByDefinitionId: this.#refusalsWith(
          definitionId,
          deleteAlreadyRunning(runningDefinitionId === definitionId),
        ),
      });
      return;
    }
    this.#publish({
      armedDeletionId: undefined,
      deletingId: definitionId,
      // Dropped on the attempt so a new press does not show last time's reason.
      refusalByDefinitionId: this.#refusalsWithout(definitionId),
    });
    try {
      await this.#calls.deleteDefinition({ definitionId });
    } catch (error) {
      if (!this.#isDisposed && this.#snapshot.deletingId === definitionId) {
        this.#publish({
          deletingId: undefined,
          refusalByDefinitionId: this.#refusalsWith(
            definitionId,
            normalizeWireRejection(AGENT_LIBRARY_REFUSAL_ORIGIN, error),
          ),
        });
      }
      return;
    }
    // Once the lock moved or the view was disposed, this settlement is not the page's to fold in.
    if (this.#isDisposed || this.#snapshot.deletingId !== definitionId) {
      return;
    }
    this.#publish({
      deletingId: undefined,
      // An editor open on the deleted record has nothing behind it, so it closes with it.
      editorSubject: subjectSurviving(this.#snapshot.editorSubject, definitionId),
    });
    await this.#read();
  }

  /**
   * Re-read the registry. The reading is replaced on settlement, never reset to `not-loaded`
   * first, so a refresh does not blank rows the page already holds.
   */
  async #read(): Promise<void> {
    const read = this.#reads.supersedeAndClaim(this, REGISTRY_READ_KEY);
    const definitions = await this.#calls.listDefinitions();
    if (this.#isDisposed) {
      return;
    }
    read.settle(() => {
      this.#publish({ reading: readDefinitions(definitions) });
    });
    read.release();
  }

  #refusalsWith(definitionId: string, refusal: Refusal): ReadonlyMap<string, Refusal> {
    return new Map(this.#snapshot.refusalByDefinitionId).set(definitionId, refusal);
  }

  #refusalsWithout(definitionId: string): ReadonlyMap<string, Refusal> {
    const remaining = new Map(this.#snapshot.refusalByDefinitionId);
    remaining.delete(definitionId);
    return remaining;
  }

  /**
   * Fold one transition in and hand out a new identity. The snapshot is held, not composed per
   * read, because `useSyncExternalStore` renders forever on a fresh object each call.
   */
  #publish(changes: Partial<Omit<AgentLibrarySnapshot, "revision">>): void {
    this.#snapshot = { ...this.#snapshot, ...changes, revision: this.#snapshot.revision + 1 };
    this.#changes.emit(this.#snapshot);
  }
}

/**
 * Why this view declined a delete it never sent. The two sentences differ because what a person
 * does next differs: their own row is already leaving, or another row's delete is in front.
 */
function deleteAlreadyRunning(isTheSameRecord: boolean): Refusal {
  return refuse(
    AGENT_LIBRARY_REFUSAL_ORIGIN,
    "delete-already-running",
    isTheSameRecord
      ? "This sidekick is already being deleted. It is asked once, and the row changes when the registry answers."
      : "Another sidekick is being deleted. Wait for that one to settle, then press Delete again.",
  );
}

/** Close an editor open on a record that has just been deleted; leave any other. */
function subjectSurviving(
  subject: AgentDefinitionEditorSubject | undefined,
  deletedDefinitionId: string,
): AgentDefinitionEditorSubject | undefined {
  if (subject?.kind === "stored" && subject.definitionId === deletedDefinitionId) {
    return undefined;
  }
  return subject;
}
