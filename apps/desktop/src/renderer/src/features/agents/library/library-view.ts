// What the agent library HOLDS: the registry read, the delete in flight, and which
// record the editor is open on.
//
// It is a module of its own rather than a class at the top of `AgentLibrary.tsx`
// because the two are different jobs — one owns a state machine over the registry calls,
// the other renders whatever that machine settled on — which is the seam the
// module-shape rule in `apps/desktop/AGENTS.md` splits on. The page imports the hook
// and reads a snapshot; it never makes the calls itself.
//
// ONE CLASS RATHER THAN THREE PIECES OF COMPONENT STATE, because the three move
// together: a delete the daemon applied clears the row, re-reads the list, and
// closes the editor if it was open on the record that just stopped existing. Three
// `useState` calls updated in sequence is that same machine with its illegal
// intermediate states reachable and unnamed.
//
// A REJECTED CALL IS NOT CAUGHT HERE. It reaches whoever pressed or mounted; the delete
// gives its lock back on the way out so the page does not stay disabled.

import { consoleClockFor, type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { refuse, type ConsoleRefusal } from "@renderer/lib/refusal.js";
import { GenerationLatch } from "@renderer/console/store/read/generation-latch.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/console/store/read/read-triggers.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { ListAgentDefinitions } from "../agent-reads.js";
import { readDefinitions, type AgentDefinitionReading } from "./definition-rows.js";

/**
 * Deletes one saved definition. Rejects when the daemon refuses.
 */
export type DeleteAgentDefinition = (request: {
  readonly definitionId: string;
}) => Promise<unknown>;

/** The registry calls the view drives. Held stable by the caller. */
export interface AgentRegistryCalls {
  readonly listDefinitions: ListAgentDefinitions;
  readonly deleteDefinition: DeleteAgentDefinition;
}

/**
 * Which record the editor is open on.
 *
 * A closed two-arm union rather than an optional id, because "edit this stored
 * definition" and "compose one that does not exist yet" are different acts with
 * different daemon verbs behind them. `definitionId` and never `name`: the name is a
 * mutable label a person may change at any time.
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
  readonly refusalByDefinitionId: ReadonlyMap<string, ConsoleRefusal>;
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
 * The carrier.
 *
 * THE READ HAS A LATCH KEY AND THE DELETE HAS A LOCK, and the two stay apart. They
 * are independent calls, and one round shared between them would let a delete
 * pressed while the first read was still in flight discard that read's own reply.
 *
 * A READ SUPERSEDES AND A DELETE DOES NOT. A re-read asked while one is in flight is
 * the newer question, so the older reply writes nothing — which is what the latch
 * key is for. A delete is the one act on this page with no undo, so a second confirm
 * while one is running is refused rather than run: under a superseding round, the
 * second delete's settlement would win and the first's re-read would be skipped, so a
 * record the daemon really did remove would sit on screen for the life of the page
 * with the OTHER row's refusal as the only thing explaining it. `deletingId` is
 * therefore both the lock and the record of which delete is running — one field, so
 * the guard and the page's own disabled controls cannot disagree.
 */
export class AgentLibraryView implements ReadTriggerTarget {
  /**
   * No terminal event refreshes this read, and the empty set states it.
   *
   * The definition registry is node-local and nothing on the session stream announces a
   * change to it, so there is no kind a store could admit and none this view could
   * listen for. The window triggers are therefore the whole refresh story — which is why
   * the read goes through a scheduler rather than firing once from `start` and never
   * again.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #calls: AgentRegistryCalls;
  readonly #changes = new Emitter<AgentLibrarySnapshot>("agent registry change");
  #snapshot: AgentLibrarySnapshot = NOTHING_READ;
  #hasStarted = false;
  #isDisposed = false;
  /**
   * Which read this view is on, through the console's one latch.
   *
   * A refresh SUPERSEDES the read before it, because both answer one question and
   * only the later one was asked. The key is given back on settlement, so the
   * register holds nothing between reads.
   */
  readonly #reads = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;

  public constructor(bridge: ConsoleBridge, calls: AgentRegistryCalls) {
    this.#calls = calls;
    this.#scheduler = new RefreshScheduler({
      clock: consoleClockFor(bridge),
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
   * Ask for a read.
   *
   * `subscribe` on mount and `window-focus` on return — the two reasons that reach a
   * registry nothing evented. A definition created by another window, by the CLI, or
   * by a peer is invisible to this page until one of them fires, which is a staleness
   * a once-only read had no path out of at all.
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
   * Delete one record, then RE-READ rather than dropping a local copy.
   *
   * The list the page renders is the registry's answer and never a copy the page
   * edits: removing the row here would make the screen agree with a delete the
   * daemon may have applied differently, or not at all.
   *
   * ONE AT A TIME, and the second press is answered rather than dropped. The page
   * disables every delete control while one is running, so a press that reaches here
   * is one that surface could not intercept — and doing nothing at all would be
   * indistinguishable from a broken control, so the row it was aimed at gets this
   * view's own refusal saying what is in the way.
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
      // Dropped on the attempt rather than on its settlement, so a person pressing
      // again does not read last time's reason beside this time's spinner.
      refusalByDefinitionId: this.#refusalsWithout(definitionId),
    });
    try {
      await this.#calls.deleteDefinition({ definitionId });
    } catch (error) {
      if (!this.#isDisposed && this.#snapshot.deletingId === definitionId) {
        this.#publish({ deletingId: undefined });
      }
      throw error;
    }
    // The lock is still this record's, or this settlement is no longer the page's
    // to fold in — the same belt the disposal flag beside it is.
    if (this.#isDisposed || this.#snapshot.deletingId !== definitionId) {
      return;
    }
    this.#publish({
      deletingId: undefined,
      // An editor open on the record that just stopped existing is a subject with
      // nothing behind it, so it closes with the record; one on another is left.
      editorSubject: subjectSurviving(this.#snapshot.editorSubject, definitionId),
    });
    await this.#read();
  }

  /**
   * Re-read the registry.
   *
   * The reading is REPLACED on settlement and never reset to `not-loaded` first: a
   * refresh that blanked the list would take rows off the screen to show a spinner
   * for data the page is already holding, so that absence is entered once, by the
   * first read, and never re-entered.
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

  #refusalsWith(
    definitionId: string,
    refusal: ConsoleRefusal,
  ): ReadonlyMap<string, ConsoleRefusal> {
    return new Map(this.#snapshot.refusalByDefinitionId).set(definitionId, refusal);
  }

  #refusalsWithout(definitionId: string): ReadonlyMap<string, ConsoleRefusal> {
    const remaining = new Map(this.#snapshot.refusalByDefinitionId);
    remaining.delete(definitionId);
    return remaining;
  }

  /**
   * Fold one transition in and hand out a new identity.
   *
   * The snapshot is HELD rather than composed on each read, because
   * `useSyncExternalStore` compares identity: a getter returning a fresh object on
   * every call renders forever.
   */
  #publish(changes: Partial<Omit<AgentLibrarySnapshot, "revision">>): void {
    this.#snapshot = { ...this.#snapshot, ...changes, revision: this.#snapshot.revision + 1 };
    this.#changes.emit(this.#snapshot);
  }
}

/**
 * Why this view declined a delete it never sent.
 *
 * Two sentences under one code, because what a person does next differs: their own
 * row is already on its way out, and another row's delete is in front of theirs.
 * Neither names the record in the way, which would say nothing they can act on.
 */
function deleteAlreadyRunning(isTheSameRecord: boolean): ConsoleRefusal {
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
