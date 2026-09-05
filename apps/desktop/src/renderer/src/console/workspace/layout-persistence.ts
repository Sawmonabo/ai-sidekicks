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
// AND THE WRITER IS ADDRESSED BY THE STORE IT WRITES THROUGH. The record goes into a
// `UiStateStore`, and that store is replaced under a live surface: a reconnect
// re-mints it and the composition root hands the new one down without remounting
// anything beneath. A writer built in a `useState` initializer closes over the store
// of its FIRST render and keeps writing there, so every later arrangement is filed in
// a store nothing will ever read again — and the restore, which does move, then reads
// the newer store's older record. Both writers are therefore held per store through
// `store/subject-scoped-resource.ts`, which retires the one bound to the store that
// was replaced.
//
// RETIREMENT DRAINS; IT DOES NOT CANCEL. `flushAndClose` sends the pending snapshot
// before it stops accepting requests, because the last arrangement a person made is
// exactly the one they expect to find, and a terminal that threw it away would be
// worse than the no-terminal this class shipped with. A request arriving after
// retirement is dropped rather than filed: the surface on screen holds the writer
// bound to the live store, and that is where its arrangement belongs.

import { useEffect, useState } from "react";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { type UiStateStore } from "../persistence/index.js";
import { useSubjectScopedResource, useSubjectScopedState } from "../store/index.js";
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
  #isRetired = false;

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
    if (this.#isRetired) {
      // Dropped rather than filed: this writer's store has been replaced, and the
      // surface on screen is already holding the writer bound to the live one.
      return;
    }
    this.#pending = { partition, snapshot };
    this.#pump();
  }

  /**
   * Send what is waiting, then stop accepting requests. The terminal, and total.
   *
   * Called when the store this writer was built over is replaced. It DRAINS: the
   * pending slot holds the newest arrangement, and a teardown that dropped it would
   * throw away the one act the person performed last. Where a write is already in
   * flight there is nothing to start — the pump's own `finally` sends the pending one
   * — so this needs no `await` and answers in both states.
   */
  public flushAndClose(): void {
    this.#pump();
    this.#isRetired = true;
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

/**
 * How a retired writer ends, declared once and shared by both records.
 *
 * A module-level function rather than an arrow at each call site: the holder keeps
 * the disposal on a dependency of its own, and a fresh closure per render would
 * restart that lifetime effect on every pass for no change in what is open.
 */
export function flushAndCloseWriter(writer: CoalescingLayoutWriter<PersistedLayoutRecord>): void {
  writer.flushAndClose();
}

/**
 * How far one surface's restore has got, for one arrangement and one session.
 *
 * TWO ANSWERS AND NEITHER IS RENDER STATE. "Has this restore been dispatched" gates
 * an effect, and a flag that re-rendered would re-run the very effect it gates;
 * "has it landed" is read from inside the layout subscription, a callback that
 * outlives the render which installed it, and a captured render value there would be
 * whatever was true when the subscription was made. A mutable holder answers both
 * from wherever they are asked.
 *
 * WHAT IT IS ADDRESSED BY IS THE POINT. Held per `(arrangement, session)` through
 * `store/subject-scoped-state.ts`, so routing to another open session re-arms it and a
 * `UiStateStore` REPLACEMENT — a reconnect re-mints the store and hands it down
 * without remounting anything — does not. A restore that re-ran there would replace a
 * deck the person has been arranging for minutes with whatever the record holds,
 * which reads as the window silently undoing their work.
 *
 * It owns nothing, so it is a value and not a resource: there is no disposal, and a
 * holder that dropped it needs to do nothing about the one it dropped.
 */
export class RestoreProgress {
  #hasStarted = false;
  #hasSettled = false;

  /** True while no read has been dispatched for this pair. The dispatch gate. */
  public get isUnstarted(): boolean {
    return !this.#hasStarted;
  }

  /** True once the record has been adopted — the moment saving may begin. */
  public get hasSettled(): boolean {
    return this.#hasSettled;
  }

  public start(): void {
    this.#hasStarted = true;
  }

  public settle(): void {
    this.#hasSettled = true;
  }

  /**
   * Give the dispatch gate back, where the read never landed.
   *
   * A read abandoned before it settled — the effect torn down, the strict-mode
   * double mount — has adopted nothing, so the next pass must be free to read again.
   * A settled restore is never re-armed by this: it has already replaced the deck,
   * and reading a second time is what this whole holder exists to prevent.
   */
  public abandon(): void {
    if (!this.#hasSettled) {
      this.#hasStarted = false;
    }
  }
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
  //
  // AND THE WRITER ITSELF IS HELD PER STORE. The partition axis above is the session;
  // this is the other one. The store handed down is replaced on a reconnect without
  // remounting this surface, and a writer that closed over the first one goes on
  // writing into it — so the holder retires that writer, draining what it had queued,
  // and the render that first sees the new store builds the writer bound to it.
  const { value: writer } = useSubjectScopedResource<CoalescingLayoutWriter<PersistedLayoutRecord>>(
    uiStateStore,
    undefined,
    () =>
      new CoalescingLayoutWriter<PersistedLayoutRecord>({
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
    flushAndCloseWriter,
  );

  // Closed until the read has landed, and re-armed for the session arriving rather than
  // for the store: the deck is the subject and the session is the key, so a `UiStateStore`
  // replacement leaves this exactly as it was. It is a write gate and a dispatch gate and
  // nothing else, which is why it is held here rather than on the deck: the sidebar's
  // `hasSettled` is a rendered fact its surface announces on, so hoisting one of the two
  // onto the other would give a persistence gate a place in a rendered state shape, or an
  // announcement a place in a hook.
  const { value: restore } = useSubjectScopedState(layout, sessionId, () => new RestoreProgress());

  useEffect(() => {
    if (sessionId === undefined || !restore.isUnstarted) {
      return;
    }
    restore.start();
    let superseded = false;
    void (async () => {
      // WHAT THE DECK HELD WHEN THE READ STARTED, so an arrangement the person makes
      // while it is in flight can be told from the one being read. A slow read is not
      // hypothetical — the store is on the other side of a process boundary — and the
      // deck is live the whole time it is running.
      const paneIdsBeforeRead = new Set(layout.snapshot().panes.map((pane) => pane.paneId));
      const revisionBeforeRead = layout.snapshot().revision;
      const record = await uiStateStore.read(sessionId, DECK_LAYOUT_RECORD_KEY);
      if (superseded) {
        return;
      }

      // BOTH ARE HONOURED, IN THIS ORDER: the saved arrangement lands, and then the
      // panes the person opened while it was being read are opened on top of it. The
      // deck's own restore replaces wholesale — correctly, since a merge rule for two
      // decks is a rule nothing could state — so the replay is what keeps a just-opened
      // pane from vanishing under a record that predates it. `open` focuses a pane
      // already showing that address, so replaying one the record also held is not a
      // second copy of it.
      //
      // The replay set is the panes ADDED during the read rather than the panes
      // present, because on a route from one open session to another the deck can hold
      // the previous session's panes, and replaying those would move them into a
      // session nobody put them in.
      const actedDuringRead = layout.snapshot().revision !== revisionBeforeRead;
      const panesOpenedDuringRead = actedDuringRead
        ? layout.snapshot().panes.filter((pane) => !paneIdsBeforeRead.has(pane.paneId))
        : [];

      const report = record === undefined ? undefined : layout.restore(record.value);
      if (report !== undefined && report.refusals.length > 0) {
        setRestoreRefusals(report.refusals);
      }
      for (const pane of panesOpenedDuringRead) {
        layout.open({ kind: pane.kind, entity: pane.entity });
      }
      if (layout.snapshot().panes.length === 0) {
        // This surface's own empty state: the workspace shows the ledger alone, full
        // width.
        layout.open({ kind: "timeline", entity: undefined });
      }

      // Opened only now, so nothing above reached the store: every commit this block
      // made is either what the record already held or what the write below carries.
      restore.settle();
      if (actedDuringRead || (report?.restoredPaneCount ?? 0) === 0) {
        // ONCE, and only where the deck on screen is not what the record held: the
        // person's arrangement, or the fallback ledger this surface just opened.
        writer.request(sessionId, layout.toSnapshot());
      }
    })();
    return () => {
      superseded = true;
      // Abandoned before it landed, so the gate goes back: this pass adopted nothing,
      // and a pass that never reads again would leave the deck saving an arrangement it
      // never restored.
      restore.abandon();
    };
  }, [layout, restore, sessionId, uiStateStore, writer]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return layout.subscribe(() => {
      // Nothing is written before the restore has landed — the ordering the sidebar's
      // persistence states in the same words. A write from the transient deck would
      // replace the very record the read above is still resolving, and the person would
      // find a first-run window where their arrangement had been.
      if (!restore.hasSettled) {
        return;
      }
      writer.request(sessionId, layout.toSnapshot());
    });
  }, [layout, restore, writer, sessionId]);

  return restoreRefusals;
}
