// What the sidekicks page HOLDS: the registry read, the delete in flight, and which
// record the editor's seat is open on.
//
// It is a module of its own rather than a class at the top of `DefinitionsPage.tsx`
// because the two are different jobs — one owns a state machine over the growth
// port, the other renders whatever that machine settled on — and `apps/desktop`
// AGENTS.md's length rule is where that shows up first. The page imports the hook
// and reads a snapshot; it never calls the port itself.
//
// ONE CLASS RATHER THAN THREE PIECES OF COMPONENT STATE, because the three move
// together: a delete the daemon applied clears the row, re-reads the list, and
// closes the seat if it was open on the record that just stopped existing. Three
// `useState` calls updated in sequence is that same machine with its illegal
// intermediate states reachable and unnamed.
//
// IT IS NOT `collaboration/mutation-coordinator.ts`, and the reason is the seam
// rather than the shape: that coordinator's failure arm normalizes a REJECTION,
// because the daemon gateway it drives throws, while the growth port refuses by
// RETURNING a value that already is the console's refusal shape
// (`bridge/growth-outcome.ts` extends `ConsoleRefusal`). Routing one through the
// other would mean raising a refusal in order to parse it back into what it started
// as. `settings/pages/shell-preferences.ts` is the precedent followed instead: a
// growth-port carrier owning its own pending key, refusal map, and generation.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import { useSettlementAnnouncement } from "../primitives/index.js";
import {
  describeDefinitionSettlement,
  readDefinitionOutcome,
  type SidekickDefinitionReading,
} from "./definition-rows.js";
import type { SidekickDefinitionEditorSubject } from "./DefinitionEditorSlot.js";

/** Everything the page renders from, in one value. */
export interface SidekickRegistrySnapshot {
  readonly reading: SidekickDefinitionReading;
  /** The row whose delete has been asked but not confirmed. One at a time. */
  readonly armedDeletionId: string | undefined;
  readonly deletingId: string | undefined;
  /** The last refusal per row, dropped when that row is attempted again. */
  readonly refusalByDefinitionId: ReadonlyMap<string, ConsoleRefusal>;
  readonly editorSubject: SidekickDefinitionEditorSubject | undefined;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_READ: SidekickRegistrySnapshot = {
  reading: { kind: "not-loaded" },
  armedDeletionId: undefined,
  deletingId: undefined,
  refusalByDefinitionId: new Map(),
  editorSubject: undefined,
  revision: 0,
};

/** The subsystem name the refusals this view raises on its own carry. */
export const SIDEKICK_REGISTRY_REFUSAL_ORIGIN = "sidekick-registry-view";

/**
 * The carrier.
 *
 * THE READ HAS A GENERATION AND THE DELETE HAS A LOCK, and the two stay apart. They
 * are independent calls, and one counter shared between them would let a delete
 * pressed while the first read was still in flight discard that read's own reply.
 *
 * A READ SUPERSEDES AND A DELETE DOES NOT. A re-read asked while one is in flight is
 * the newer question, so the older reply writes nothing — which is what the counter
 * is for. A delete is the one act on this page with no undo, so a second confirm
 * while one is running is refused rather than run: under a counter, the second
 * delete's settlement would win and the first's re-read would be skipped, so a
 * record the daemon really did remove would sit on screen for the life of the page
 * with the OTHER row's refusal as the only thing explaining it. `deletingId` is
 * therefore both the lock and the record of which delete is running — one field, so
 * the guard and the page's own disabled controls cannot disagree.
 */
export class SidekickRegistryView {
  readonly #bridge: ConsoleBridge;
  readonly #changes = new Emitter<SidekickRegistrySnapshot>("sidekick registry change");
  #snapshot: SidekickRegistrySnapshot = NOTHING_READ;
  #hasStarted = false;
  #isDisposed = false;
  #readGeneration = 0;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
  }

  public snapshot(): SidekickRegistrySnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Read the registry once. Idempotent: strict mode mounts an effect twice. */
  public start(): void {
    if (this.#hasStarted || this.#isDisposed) {
      return;
    }
    this.#hasStarted = true;
    void this.#read();
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
  }

  /** Ask the question. Arming a second row drops the first, so only one is open. */
  public armDeletion(definitionId: string): void {
    this.#publish({ armedDeletionId: definitionId });
  }

  public cancelDeletion(): void {
    this.#publish({ armedDeletionId: undefined });
  }

  public openEditor(subject: SidekickDefinitionEditorSubject): void {
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
    const outcome = await this.#bridge.growth.sidekickDefinitionDelete({ definitionId });
    // The lock is still this record's, or this settlement is no longer the page's
    // to fold in — the same belt the disposal flag beside it is.
    if (this.#isDisposed || this.#snapshot.deletingId !== definitionId) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#publish({
        deletingId: undefined,
        refusalByDefinitionId: this.#refusalsWith(definitionId, outcome),
      });
      return;
    }
    this.#publish({
      deletingId: undefined,
      // A seat open on the record that just stopped existing is a subject with
      // nothing behind it, so it closes with the record; a seat on another is left.
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
    const generation = (this.#readGeneration += 1);
    const outcome = await this.#bridge.growth.sidekickDefinitionList({});
    if (this.#isDisposed || generation !== this.#readGeneration) {
      return;
    }
    this.#publish({ reading: readDefinitionOutcome(outcome) });
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
  #publish(changes: Partial<Omit<SidekickRegistrySnapshot, "revision">>): void {
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
    SIDEKICK_REGISTRY_REFUSAL_ORIGIN,
    "delete-already-running",
    isTheSameRecord
      ? "This sidekick is already being deleted. It is asked once, and the row changes when the registry answers."
      : "Another sidekick is being deleted. Wait for that one to settle, then press Delete again.",
  );
}

/** Close a seat open on a record that has just been deleted; leave any other. */
function subjectSurviving(
  subject: SidekickDefinitionEditorSubject | undefined,
  deletedDefinitionId: string,
): SidekickDefinitionEditorSubject | undefined {
  if (subject?.kind === "stored" && subject.definitionId === deletedDefinitionId) {
    return undefined;
  }
  return subject;
}

/**
 * Build the view and let it read.
 *
 * Constructed in a memo and STARTED in an effect, the split
 * `frame/session-lifecycle.ts` states one level up: building it owns nothing — no
 * timer, no subscription, no call in flight — and the read is the side effect that
 * must not happen during render, so a memo React discards costs a discarded object
 * and no request.
 */
export function useSidekickRegistryView(bridge: ConsoleBridge): {
  readonly view: SidekickRegistryView;
  readonly snapshot: SidekickRegistrySnapshot;
} {
  const view = useMemo(() => new SidekickRegistryView(bridge), [bridge]);
  useEffect(() => {
    view.start();
    return () => {
      view.dispose();
    };
  }, [view]);
  const snapshot = useSyncExternalStore(
    (onStoreChange: () => void) => view.subscribe(onStoreChange),
    () => view.snapshot(),
    () => view.snapshot(),
  );
  return { view, snapshot };
}

/**
 * Say what this read settled on, through the console's one settlement announcer.
 *
 * COMPOSES A SENTENCE AND GUARDS NOTHING. The repetition rule belongs to
 * `primitives/settlement-announcement.ts` and is keyed on the SENTENCE, which is
 * the only key that is correct here: a flag held once for the life of the mount
 * silences everything after the first settlement, so the refusal that follows a
 * re-read — the delete this page performs, then fails to re-list — was never
 * spoken at all, and the surface that could not be read said so only to people
 * who could see it.
 *
 * `undefined` while the read is in flight, which is that hook's "still reading"
 * arm; `describeDefinitionSettlement` is narrowed to a settled reading and is
 * reached only past that check.
 */
export function useDefinitionSettlementAnnouncement(reading: SidekickDefinitionReading): void {
  useSettlementAnnouncement(
    reading.kind === "not-loaded" ? undefined : describeDefinitionSettlement(reading),
  );
}
