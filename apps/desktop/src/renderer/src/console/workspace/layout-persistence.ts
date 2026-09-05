// Restoring the deck's arrangement, and keeping it saved.
//
// A hook and the two gates it runs on. The coalescing write itself is
// `layout-writer.ts`, which this module holds one of per store; what is here is the
// ORDER the two halves happen in — the record is read before anything is written, and
// read exactly once for the arrangement and session on screen.
//
// THE RESTORE HAPPENS ONCE AND THE SAVE WAITS FOR IT. A save that fired before the
// restore completed would file an empty deck over the record it was about to read, and
// the result looks identical to a first run. A restore that ran a SECOND time would
// replace an arrangement the person built with whatever the record holds, which reads
// as the window undoing their work; `RestoreProgress` below is addressed so that
// neither can happen.

import { useEffect, useState } from "react";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { type UiStateStore } from "../persistence/index.js";
import { useSubjectScopedResource, useSubjectScopedState } from "../store/index.js";
import { type DeckLayout } from "./deck/deck-layout.js";
import {
  CoalescingLayoutWriter,
  flushAndCloseWriter,
  isWriterRetired,
  type PersistedLayoutRecord,
} from "./layout-writer.js";
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
    // `flushAndClose` is ONE-WAY: a retired writer drops every later request
    // silently, so a holder that re-committed one after a double-mount would
    // leave the person rearranging all session with nothing kept and no refusal
    // raised. This reading is how the holder tells a retired writer from a live
    // one and mints a fresh one instead.
    isWriterRetired,
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
