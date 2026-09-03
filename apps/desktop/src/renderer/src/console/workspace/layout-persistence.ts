// Keeping the workspace's arrangement on disk, without arming a timer to do it.
//
// The problem is the resize drag: a separator commits a new layout on every
// pointer move, so a naive "save on change" writes sixty records a second to a
// database that only needs to hold the last one.
//
// WHY THIS IS NOT A DEBOUNCE, AND NOT `store/scheduling.ts`. The obvious answer is
// a trailing debounce, and the console already owns one — `RefreshScheduler`. It is
// the wrong tool twice over: its own header says the session-store registry is what
// constructs it and nothing else in the tree may arm a timer, and its
// `RefreshReason` vocabulary is a diagnostics field whose doc forbids inventing a
// value for a read nobody asked for. A deck rearrangement is not a refresh, and
// there is no honest reason to hand it. Writing a second debouncer beside that one
// would be a second implementation of the thing it exists to be.
//
// So the coalescing comes from the write itself: at most ONE write is in flight,
// and while one is, further changes replace a single pending snapshot rather than
// queueing. A drag costs as many writes as the database can absorb — each of them
// the newest arrangement, never a stale one — with no timer to arm, cancel, or
// leak, and nothing for a test to advance.
//
// AND THE PARTITION RIDES THE REQUEST, NOT THE CALLER'S CURRENT STATE. A request
// names the session its snapshot belongs to, and the single pending slot carries
// both, so the pump writes what the request named however long it waited. The
// alternative — reading the caller's current session inside the write callback —
// files a queued arrangement under whichever session the person navigated to while
// it waited, which overwrites that session's saved deck with another one's.
//
// TWO RECORDS, ONE WRITER, AND WHY THIS MODULE LEFT `deck/`. The deck's arrangement
// was the first record kept this way; the session sidebar's width, collapse, and open
// section is the second. Both are the persistence chokepoint's `layout` value class,
// both are written on a gesture, and both need exactly the coalescing below — so the
// writer is generic over the record it carries and lives at the family's own level
// rather than inside the deck's subtree. A second writer beside it would be the one
// thing this file exists to be.
//
// AND THERE IS NOTHING TO DISPOSE, WHICH IS THE POINT. This class arms no timer,
// holds no subscription, and reaches no DOM node, so it owns no resource a pane's
// unmount has to reclaim. A `dispose()` here would either be a no-op that reads as
// a lifecycle, or a cancel that throws away the last arrangement the person made
// before they closed the pane — which is exactly the one they expect to find when
// they open it again. The surface stops calling `request`; that is the whole
// teardown.

import { useEffect, useState } from "react";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { type UiStateStore } from "../persistence/index.js";
import { type DeckLayout } from "./deck/deck-layout.js";

/**
 * The shape the persistence chokepoint's `layout` value class admits: an object of
 * objects whose members are numbers, booleans, and identifier-shaped strings.
 *
 * Written here rather than imported from either record's own grammar, because it is
 * the CLASS's constraint and not either grammar's preference — the deck names its
 * own record `DeckSnapshotRecord` and the sidebar names its own, and both satisfy
 * this because both are stored under that one class.
 */
export type PersistedLayoutRecord = Record<string, Record<string, number | boolean | string>>;

export interface CoalescingLayoutWriterOptions<TRecord extends PersistedLayoutRecord> {
  /**
   * Performs one durable write, under the partition the request named. A refusal
   * is the caller's to render.
   */
  readonly write: (partition: string, snapshot: TRecord) => Promise<void>;
  /** A write that rejected outright, as opposed to one the store refused. */
  readonly onFailed: (error: unknown) => void;
}

/** One arrangement, and the session it belongs to. The two travel together. */
interface PendingLayoutWrite<TRecord extends PersistedLayoutRecord> {
  readonly partition: string;
  readonly snapshot: TRecord;
}

export class CoalescingLayoutWriter<TRecord extends PersistedLayoutRecord> {
  readonly #write: (partition: string, snapshot: TRecord) => Promise<void>;
  readonly #onFailed: (error: unknown) => void;
  #pending: PendingLayoutWrite<TRecord> | undefined;
  #inFlight = false;
  #writeCount = 0;

  public constructor(options: CoalescingLayoutWriterOptions<TRecord>) {
    this.#write = options.write;
    this.#onFailed = options.onFailed;
  }

  /** Writes performed, so a test can count them rather than infer a coalesce. */
  public get writeCount(): number {
    return this.#writeCount;
  }

  /** True when nothing is in flight and nothing is waiting to go. */
  public get isIdle(): boolean {
    return !this.#inFlight && this.#pending === undefined;
  }

  /**
   * Save this arrangement, under the session it belongs to.
   *
   * The newest request REPLACES an unsent one rather than joining a queue: the
   * layout is a single current value, and writing an arrangement the person has
   * already moved past would put a stale record on disk and then correct it. The
   * partition travels with the snapshot for the same reason it exists at all — a
   * queued write settles later than the act that queued it, and by then the caller's
   * own idea of the current session may have moved on.
   */
  public request(partition: string, snapshot: TRecord): void {
    this.#pending = { partition, snapshot };
    this.#pump();
  }

  #pump(): void {
    if (this.#inFlight || this.#pending === undefined) {
      return;
    }
    const { partition, snapshot } = this.#pending;
    this.#pending = undefined;
    this.#inFlight = true;
    this.#writeCount += 1;
    void this.#write(partition, snapshot)
      .catch((error: unknown) => {
        this.#onFailed(error);
      })
      .finally(() => {
        this.#inFlight = false;
        this.#pump();
      });
  }
}

/** The durable record the deck's arrangement is saved under, per session. */
export const DECK_LAYOUT_RECORD_KEY = "deck-layout";

/** Why the workspace itself refused. Closed, so a second cause is a decision. */
export const WORKSPACE_REFUSAL_CODES = ["layout-save-failed"] as const;

/** One workspace refusal code. Derived, so the vocabulary is declared once. */
export type WorkspaceRefusalCode = (typeof WORKSPACE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this surface raises carries. */
export const WORKSPACE_REFUSAL_ORIGIN = "workspace";

/** A typed workspace refusal — `core`'s one refusal shape, narrowed on `code`. */
interface WorkspaceRefusal extends ConsoleRefusal {
  readonly code: WorkspaceRefusalCode;
}

/**
 * Raise one, from the closed vocabulary above.
 *
 * `refuse` takes its code as a `string`, so a call site that spelled one wrong
 * would compile and render a code no reader could look up. Everything this surface
 * refuses goes through here instead, where the union is what binds.
 */
export function refuseWorkspace(code: WorkspaceRefusalCode, detail: string): WorkspaceRefusal {
  return { ...refuse(WORKSPACE_REFUSAL_ORIGIN, code, detail), code };
}

export interface DeckPersistenceOptions {
  readonly layout: DeckLayout;
  readonly uiStateStore: UiStateStore;
  readonly sessionId: string | undefined;
  readonly onSaveRefused: (refusal: ConsoleRefusal) => void;
}

/**
 * Restore the deck once, then keep it saved. Returns what the restore refused.
 *
 * A hook rather than two effects in the component body, because the two halves are
 * one story: the restore has to complete before the first save, or an empty deck
 * would overwrite the record it was about to read.
 */
export function useDeckPersistence(options: DeckPersistenceOptions): readonly ConsoleRefusal[] {
  const { layout, uiStateStore, sessionId, onSaveRefused } = options;
  const [restoreRefusals, setRestoreRefusals] = useState<readonly ConsoleRefusal[]>([]);

  // The partition rides the REQUEST rather than being read here. A writer coalesces,
  // so a queued arrangement settles after the act that queued it — and the workspace
  // survives a navigation between two already-open sessions, because the shell opens
  // session stores and never closes them. Reading a mutable current-session holder at
  // write time filed the older session's arrangement under the newer one's partition
  // and overwrote a deck the person had not touched.
  const [writer] = useState(
    () =>
      new CoalescingLayoutWriter({
        write: async (partition, snapshot) => {
          const result = await uiStateStore.write(
            partition,
            DECK_LAYOUT_RECORD_KEY,
            "layout",
            snapshot,
          );
          if (result.outcome === "refused") {
            onSaveRefused(result.refusal);
          }
        },
        // A write that rejects is surfaced, not thrown: an unhandled rejection out
        // of a save would take the window down over a layout the person can redraw.
        onFailed: () => {
          onSaveRefused(
            refuseWorkspace(
              "layout-save-failed",
              "This window's pane arrangement could not be saved. It is still on screen, and it will be saved again on the next change.",
            ),
          );
        },
      }),
  );

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    let superseded = false;
    void (async () => {
      const record = await uiStateStore.read(sessionId, DECK_LAYOUT_RECORD_KEY);
      if (superseded) {
        return;
      }
      const report = record === undefined ? undefined : layout.restore(record.value);
      if (report !== undefined && report.refusals.length > 0) {
        setRestoreRefusals(report.refusals);
      }
      if (report === undefined || report.restoredPaneCount === 0) {
        // This surface's own empty state: the workspace shows the ledger alone, full
        // width.
        layout.open({ kind: "timeline", entity: undefined });
      }
    })();
    return () => {
      superseded = true;
    };
  }, [layout, sessionId, uiStateStore]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return layout.subscribe(() => {
      writer.request(sessionId, layout.toSnapshot());
    });
  }, [layout, writer, sessionId]);

  return restoreRefusals;
}
