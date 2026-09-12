// What is selected across the column's sections, and what each selected row settled as.
//
// A CLASS, for `sidebar-model.ts`'s reasons and one more. The selection is addressed
// from eight independently mounted section bodies, it outlives any one of them (a
// section a person collapses mid-selection does not drop its rows out of the set), and
// the outcomes arrive from replies that land outside React's knowledge. A component
// holding this would be a component every section had to be a child of.
//
// SELECTION IS ACT-SCOPED, NOT SECTION-SCOPED. A person may select three queued items
// and two worktrees at once, and the bar then offers two acts. What it never does is run
// one act over rows that do not admit it: every item names its own act, and the runner
// takes only the rows whose act is the one being run.
//
// AN OUTCOME OUTLIVES THE SELECTION IT CAME FROM. A row that settled is taken out of
// the selection — it has been acted on, and leaving it in would offer the act again —
// but its outcome stays, because the design track's "a failed item renders its own
// refusal and never hides the others' success" is a statement about what is on screen
// after the run, and a refusal cleared with the selection would be a refusal nobody
// read. Outcomes are dropped when the person clears them, and on nothing else.

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../../../core/index.js";
import {
  type SidebarBulkAct,
  type SidebarBulkItem,
  type SidebarBulkOutcome,
  type SidebarBulkSelection,
} from "../../../seats/index.js";

/** The whole of what the bulk surfaces render from. Replaced, never mutated in place. */
export interface BulkSelectionSnapshot {
  /** Every selected row, in selection order — which is the order the confirm names. */
  readonly selectedItems: readonly SidebarBulkItem[];
  /** What each row that has been run settled as, keyed by {@link bulkItemKey}. */
  readonly outcomeByItemKey: ReadonlyMap<string, SidebarBulkOutcome>;
  /** The row each outcome belongs to, so a settled row can be named after it left. */
  readonly settledItemByKey: ReadonlyMap<string, SidebarBulkItem>;
}

const EMPTY_SNAPSHOT: BulkSelectionSnapshot = {
  selectedItems: [],
  outcomeByItemKey: new Map(),
  settledItemByKey: new Map(),
};

export class BulkSelectionModel {
  readonly #changes = new Emitter<BulkSelectionSnapshot>("sidebar bulk selection");
  #snapshot: BulkSelectionSnapshot = EMPTY_SNAPSHOT;

  public get snapshot(): BulkSelectionSnapshot {
    return this.#snapshot;
  }

  public subscribe(listener: (snapshot: BulkSelectionSnapshot) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  public isSelected(item: SidebarBulkItem): boolean {
    const key = bulkItemKey(item);
    return this.#snapshot.selectedItems.some((selected) => bulkItemKey(selected) === key);
  }

  /** Put a row in the selection, or take it out. The person's own act either way. */
  public toggle(item: SidebarBulkItem): void {
    const key = bulkItemKey(item);
    const remaining = this.#snapshot.selectedItems.filter(
      (selected) => bulkItemKey(selected) !== key,
    );
    this.#publish({
      selectedItems:
        remaining.length === this.#snapshot.selectedItems.length
          ? [...this.#snapshot.selectedItems, item]
          : remaining,
    });
  }

  /** Every selected row that admits one act, in selection order. */
  public selectedFor(act: SidebarBulkAct): readonly SidebarBulkItem[] {
    return this.#snapshot.selectedItems.filter((item) => item.act === act);
  }

  /** Which acts the current selection can be run through, in selection order. */
  public selectedActs(): readonly SidebarBulkAct[] {
    const acts: SidebarBulkAct[] = [];
    for (const item of this.#snapshot.selectedItems) {
      if (!acts.includes(item.act)) {
        acts.push(item.act);
      }
    }
    return acts;
  }

  public outcomeFor(item: SidebarBulkItem): SidebarBulkOutcome | undefined {
    return this.#snapshot.outcomeByItemKey.get(bulkItemKey(item));
  }

  /** Empty the selection. Outcomes are untouched — they are the record of what ran. */
  public clearSelection(): void {
    if (this.#snapshot.selectedItems.length === 0) {
      return;
    }
    this.#publish({ selectedItems: [] });
  }

  /** Drop every recorded outcome. The one way a refusal leaves the screen. */
  public clearOutcomes(): void {
    if (this.#snapshot.outcomeByItemKey.size === 0) {
      return;
    }
    this.#publish({ outcomeByItemKey: new Map(), settledItemByKey: new Map() });
  }

  /**
   * Mark one row as in flight, and take it out of the selection.
   *
   * Out of the selection at DISPATCH rather than at settlement: a row still selected
   * while its call is in the air is a row the bar would offer the act for a second
   * time, and the second call would race the first.
   */
  public markRunning(item: SidebarBulkItem): void {
    this.#recordOutcome(item, { state: "running" }, { removeFromSelection: true });
  }

  /** File one row's own served reply. */
  public markDone(item: SidebarBulkItem): void {
    this.#recordOutcome(item, { state: "done" }, { removeFromSelection: false });
  }

  /** File one row's own refusal, beside the others' outcomes and never instead of them. */
  public markRefused(item: SidebarBulkItem, refusal: ConsoleRefusal): void {
    this.#recordOutcome(item, { state: "refused", refusal }, { removeFromSelection: false });
  }

  #recordOutcome(
    item: SidebarBulkItem,
    outcome: SidebarBulkOutcome,
    options: { readonly removeFromSelection: boolean },
  ): void {
    const key = bulkItemKey(item);
    const outcomeByItemKey = new Map(this.#snapshot.outcomeByItemKey);
    outcomeByItemKey.set(key, outcome);
    const settledItemByKey = new Map(this.#snapshot.settledItemByKey);
    settledItemByKey.set(key, item);
    this.#publish({
      outcomeByItemKey,
      settledItemByKey,
      ...(options.removeFromSelection
        ? {
            selectedItems: this.#snapshot.selectedItems.filter(
              (selected) => bulkItemKey(selected) !== key,
            ),
          }
        : {}),
    });
  }

  #publish(change: Partial<BulkSelectionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#changes.emit(this.#snapshot);
  }
}

/**
 * One row's key, across every section.
 *
 * The triple and not the id alone: two sections may hold rows for one entity — a run
 * appears under Runs and under its channel — and a key that ignored the section would
 * make selecting one select both. The act is in the key for the same reason at the
 * other grain: one entity can admit two acts.
 */
export function bulkItemKey(item: SidebarBulkItem): string {
  return `${item.sectionId}:${item.act}:${item.itemId}`;
}

/**
 * The narrow face a section row drives the selection through.
 *
 * Built from the model rather than the model itself: a section handed the model could
 * enumerate the whole selection and run it, and running is the column's — the confirm
 * names every item across every section, and a section cannot see that set.
 */
export function bulkSelectionFaceOf(model: BulkSelectionModel): SidebarBulkSelection {
  return {
    isSelected: (item) => model.isSelected(item),
    toggle: (item) => {
      model.toggle(item);
    },
    outcomeFor: (item) => model.outcomeFor(item),
  };
}
