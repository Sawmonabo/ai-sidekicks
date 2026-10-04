// Restores the pane layout's saved arrangement once per session, then keeps it saved.
//
// The record is read before anything is written: a save that ran first would file an empty layout
// over the record still to be read, and a second restore would replace what the person arranged.
// Results are keyed by (layout, session) because the session screen stays mounted across a route
// between two open sessions. A failed read is not a first run: the fallback transcript pane is
// opened for both `absent` and `failed`, but filed only for `absent`.

import { useEffect } from "react";

import { type Refusal } from "@renderer/lib/refusal.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";
import { paneAddressKey } from "../pane-layout.js";
import { type PaneLayoutRestoreReport } from "../pane-layout-snapshot.js";
import {
  CoalescingLayoutWriter,
  WRITER_RETIREMENT,
  type PersistedLayoutRecord,
} from "../coalescing-layout-writer.js";
import {
  PANE_LAYOUT_RECORD_KEY,
  RestoreProgress,
  refusePaneLayoutSave,
} from "../layout-persistence.js";

/** What the persistence hook binds: the layout, its store, the session, the refusal sinks. */
export interface PaneLayoutPersistenceOptions {
  readonly layout: PaneLayoutStore;
  readonly uiStateStore: UiStateStore;
  readonly sessionId: string | undefined;
  /** A save failed: the refusal, and the session whose arrangement it carried. */
  readonly onSaveRefused: (refusal: Refusal, sessionId: string) => void;
  /** A restore left part of a saved arrangement closed: one refusal, and its session. */
  readonly onRestoreRefused: (refusal: Refusal, sessionId: string) => void;
}

/**
 * Restores the pane layout once, then keeps it saved. What a restore refused goes to
 * `onRestoreRefused`; nothing is drawn for it.
 *
 * The restore must complete before the first save, or an empty layout would overwrite the
 * record it was about to read.
 */
export function usePaneLayoutPersistence(options: PaneLayoutPersistenceOptions): void {
  const { layout, uiStateStore, sessionId, onSaveRefused } = options;
  // Read when a restore lands, so a caller's fresh function does not re-run the restore effect,
  // whose cleanup would abandon a read in flight.
  const restoreRefusedRef = useLatestRef(options.onRestoreRefused);

  // The session (partition) rides each write request: the writer coalesces, so a queued
  // arrangement settles after the navigation that could change the current session.
  //
  // The writer is held per store: a reconnect replaces the store without remounting this
  // screen, so the holder retires the old writer, flushing what it queued, and builds a new one.
  const { value: writer } = useSubjectScopedResource<CoalescingLayoutWriter<PersistedLayoutRecord>>(
    uiStateStore,
    undefined,
    () =>
      new CoalescingLayoutWriter<PersistedLayoutRecord>({
        write: async (partition, snapshot) => {
          const result = await uiStateStore.write(
            partition,
            PANE_LAYOUT_RECORD_KEY,
            "layout",
            snapshot,
          );
          if (result.outcome === "refused") {
            onSaveRefused(result.refusal, partition);
          }
        },
        // A rejected write is surfaced as a refusal; a layout the person can redraw must
        // not become an unhandled rejection.
        onFailed: (_error, partition) => {
          onSaveRefused(
            refusePaneLayoutSave(
              "layout-save-failed",
              "This window's pane arrangement could not be saved. It is still " +
                "on screen, and it will be saved again on the next change.",
            ),
            partition,
          );
        },
      }),
    // `flushAndClose` is one-way; this lets the holder tell a retired writer from a live one
    // after React's double mount, instead of reusing a writer that drops requests.
    WRITER_RETIREMENT,
  );

  // Closed until the read has landed, and re-armed per session rather than per store, so a
  // `UiStateStore` replacement leaves it as it was. It gates writes and dispatch only, so it
  // stays out of the layout's rendered state, which views announce from.
  const { value: restore } = useSubjectScopedState(layout, sessionId, () => new RestoreProgress());

  useEffect(() => {
    if (sessionId === undefined || !restore.isUnstarted) {
      return;
    }
    restore.start();
    let superseded = false;
    void (async () => {
      // What the layout held when the read started, to tell the person's edits made while the
      // read is in flight (the store is across a process boundary) from the record being read.
      const paneIdsBeforeRead = new Set(layout.snapshot().panes.map((pane) => pane.paneId));
      const revisionBeforeRead = layout.snapshot().revision;

      // Every address opened while the read ran, kept even once closed again: a close leaves
      // nothing in the snapshot, so comparing before with after would let the record put the
      // closed pane back.
      const openedDuringRead = new Set<string>();
      const watchActsDuringRead = layout.subscribe((state) => {
        for (const pane of state.panes) {
          if (!paneIdsBeforeRead.has(pane.paneId)) {
            openedDuringRead.add(paneAddressKey(pane));
          }
        }
      });
      const readOutcome = await uiStateStore.readOutcome(sessionId, PANE_LAYOUT_RECORD_KEY);
      watchActsDuringRead();
      if (superseded) {
        return;
      }
      // `absent` and `failed` both leave nothing to adopt; they differ at the write below.
      const record = readOutcome.outcome === "present" ? readOutcome.record : undefined;

      // An untouched layout takes the record wholesale. A layout the person arranged during the
      // read is newer: it wins for every address it holds, and `adoptBeneath` fills in the rest,
      // honoring closes.
      //
      // Panes present before the read are dropped either way; after a route between sessions
      // they belong to the previous session.
      const actedDuringRead = layout.snapshot().revision !== revisionBeforeRead;
      let report: PaneLayoutRestoreReport | undefined;
      if (!actedDuringRead) {
        report = record === undefined ? undefined : layout.restore(record.value);
      } else {
        for (const paneId of paneIdsBeforeRead) {
          layout.close(paneId);
        }
        const liveAddresses = new Set(layout.snapshot().panes.map(paneAddressKey));
        const closedDuringRead = new Set(
          [...openedDuringRead].filter((address) => !liveAddresses.has(address)),
        );
        report =
          record === undefined ? undefined : layout.adoptBeneath(record.value, closedDuringRead);
      }
      for (const refusal of report?.refusals ?? []) {
        restoreRefusedRef.current(refusal, sessionId);
      }
      if (layout.snapshot().panes.length === 0) {
        // A window with no panes is not a state this screen has; the transcript fills it.
        layout.open({ kind: "transcript" });
      }

      // Opened only now, so no save fired during the commits above.
      restore.settle();
      if (readOutcome.outcome === "failed") {
        // Nothing is filed over a record this read could not reach: the layout on screen is the
        // fallback, not an arrangement the person asked to save. The subscription below still
        // files their next deliberate change.
        return;
      }
      if (actedDuringRead || (report?.restoredPaneCount ?? 0) === 0) {
        // Filed once, and only where the layout on screen differs from the record.
        writer.request(sessionId, layout.toSnapshot());
      }
    })();
    return () => {
      superseded = true;
      // Abandoned before it landed: this pass adopted nothing, so the gate goes back.
      restore.abandon();
    };
  }, [layout, restore, restoreRefusedRef, sessionId, uiStateStore, writer]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return layout.subscribe(() => {
      // Nothing is written before the restore lands; a write would replace the record still
      // being read.
      if (!restore.hasSettled) {
        return;
      }
      writer.request(sessionId, layout.toSnapshot());
    });
  }, [layout, restore, writer, sessionId]);
}
