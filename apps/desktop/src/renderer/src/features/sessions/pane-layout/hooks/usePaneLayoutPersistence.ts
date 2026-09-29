// Restoring the pane layout's arrangement, and keeping it saved.
//
// A hook and the two gates it runs on. The coalescing write itself is
// `layout-writer.ts`, which this module holds one of per store; what is here is the
// ORDER the two halves happen in — the record is read before anything is written, and
// read exactly once for the arrangement and session on screen.
//
// THE RESTORE HAPPENS ONCE AND THE SAVE WAITS FOR IT. A save that fired before the
// restore completed would file an empty pane layout over the record it was about to read, and
// the result looks identical to a first run. A restore that ran a SECOND time would
// replace an arrangement the person built with whatever the record holds, which reads
// as the window undoing their work; `RestoreProgress` below is addressed so that
// neither can happen.
//
// AND EVERYTHING THE RESTORE PRODUCES IS ADDRESSED BY THE SESSION IT IS ABOUT. The
// workspace stays mounted across a route between two open sessions, so a value held for
// the life of the MOUNT describes whichever session happened to produce it first: the
// restore refusals were exactly that, and a session whose saved layout could not be read
// left its errors standing over the next session's pane layout. Both the gate and the refusals
// go through `store/subject-scoped/subject-scoped-state.ts` on the same
// `(arrangement, session)` pair.
//
// AND A READ THAT FAILED IS NOT A FIRST RUN. The store's `readOutcome` answers
// `present`, `absent`, or `failed` for exactly this: the fallback ledger pane is
// opened on both kinds of nothing — a window with no panes is not a state this surface
// has — and is FILED only on `absent`. Filing it on `failed` was a saved arrangement
// destroyed by a read the adapter could not perform and then a write the adapter
// happily accepted, with nothing on screen to say so.

import { useEffect } from "react";

import { type Refusal } from "@renderer/lib/refusal.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
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

/**
 * What a session with nothing to report shows, as one value.
 *
 * One frozen array rather than a fresh one per seed and per settled restore, so a
 * subscriber comparing by identity is told nothing changed when nothing did.
 */
const NO_RESTORE_REFUSALS: readonly Refusal[] = Object.freeze([]);

/** What the persistence hook binds: the layout, its store, the session, the refusal sink. */
export interface PaneLayoutPersistenceOptions {
  readonly layout: PaneLayoutStore;
  readonly uiStateStore: UiStateStore;
  readonly sessionId: string | undefined;
  readonly onSaveRefused: (refusal: Refusal) => void;
}

/**
 * Restore the pane layout once, then keep it saved. Returns what the restore refused.
 *
 * A hook rather than two effects in the component body, because the two halves are
 * one story: the restore has to complete before the first save, or an empty pane layout
 * would overwrite the record it was about to read.
 */
export function usePaneLayoutPersistence(
  options: PaneLayoutPersistenceOptions,
): readonly Refusal[] {
  const { layout, uiStateStore, sessionId, onSaveRefused } = options;
  // WHAT A RESTORE REFUSED, ADDRESSED BY THE RESTORE THAT REFUSED IT. Held on the same
  // `(arrangement, session)` pair as the gate below, through the same holder, because
  // the workspace stays mounted across a route between two open sessions: mount state
  // here went on showing one session's restore errors over the next session's pane layout, with
  // nothing on screen tying them to the session they belong to. The seed is what a
  // session whose restore has not landed shows, which is nothing — an unsettled restore
  // makes no claim, and the previous session's is not a stand-in for one.
  const restoreRefusals = useSubjectScopedState<readonly Refusal[]>(
    layout,
    sessionId,
    () => NO_RESTORE_REFUSALS,
  );
  const publishRestoreRefusals = restoreRefusals.publish;

  // The partition rides the REQUEST rather than being read here. A writer coalesces,
  // so a queued arrangement settles after the act that queued it — and the workspace
  // survives a navigation between two already-open sessions, because the shell opens
  // session stores and never closes them. Reading a mutable current-session holder at
  // write time filed the older session's arrangement under the newer one's partition
  // and overwrote a pane layout the person had not touched.
  //
  // AND THE WRITER ITSELF IS HELD PER STORE. The partition axis above is the session;
  // this is the other one. The store handed down is replaced on a reconnect without
  // remounting this surface, and a writer that closed over the first one goes on
  // writing into it — so the holder retires that writer, flushing what it had queued,
  // and the render that first sees the new store builds the writer bound to it.
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
            onSaveRefused(result.refusal);
          }
        },
        // A write that rejects is surfaced, not thrown: an unhandled rejection out
        // of a save would take the window down over a layout the person can redraw.
        onFailed: () => {
          onSaveRefused(
            refusePaneLayoutSave(
              "layout-save-failed",
              "This window's pane arrangement could not be saved. It is still on screen, and it will be saved again on the next change.",
            ),
          );
        },
      }),
    // The terminal arm: `flushAndClose` is ONE-WAY, and the reading beside it is how
    // the holder tells a retired writer from a live one after React's double-mount
    // rather than re-committing a writer that drops every later request in silence.
    WRITER_RETIREMENT,
  );

  // Closed until the read has landed, and re-armed for the session arriving rather than
  // for the store: the pane layout is the subject and the session is the key, so a `UiStateStore`
  // replacement leaves this exactly as it was. It is a write gate and a dispatch gate and
  // nothing else, which is why it is held here rather than on the pane layout: a rendered
  // `hasSettled` is a fact a surface announces on, so hoisting one of the two onto the
  // other would give a persistence gate a place in a rendered state shape, or an
  // announcement a place in a hook.
  const { value: restore } = useSubjectScopedState(layout, sessionId, () => new RestoreProgress());

  useEffect(() => {
    if (sessionId === undefined || !restore.isUnstarted) {
      return;
    }
    restore.start();
    let superseded = false;
    void (async () => {
      // WHAT THE PANE LAYOUT HELD WHEN THE READ STARTED, so an arrangement the person makes
      // while it is in flight can be told from the one being read. A slow read is not
      // hypothetical — the store is on the other side of a process boundary — and the
      // pane layout is live the whole time it is running.
      const paneIdsBeforeRead = new Set(layout.snapshot().panes.map((pane) => pane.paneId));
      const revisionBeforeRead = layout.snapshot().revision;

      // EVERY ADDRESS OPENED WHILE THE READ RAN, kept even once it is closed again.
      // A close leaves nothing behind in the pane layout's snapshot — the pane is simply gone
      // — so a reconciliation that compares the pane layout before with the pane layout after cannot
      // see one, and the record puts the pane straight back: the person watches a pane
      // they just closed return, and the write that follows files it as theirs.
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
      // Both nothings restore the same way — there is no arrangement to adopt either
      // way — and they part company at the write below.
      const record = readOutcome.outcome === "present" ? readOutcome.record : undefined;

      // BOTH ARE HONOURED, AND WHICH ONE LEADS TURNS ON WHETHER THE PERSON ACTED. An
      // untouched pane layout takes the record wholesale, which is the restore's own rule and
      // the case that runs on nearly every mount. A pane layout the person has been arranging
      // is the NEWER arrangement, so it wins for every address it holds — order and
      // widths with it — and the record fills in only what it does not; `adoptBeneath`
      // carries that rule, closes included.
      //
      // The panes present BEFORE the read are dropped either way. On a route from one
      // open session to another the pane layout can still hold the previous session's panes,
      // and keeping those would move them into a session nobody put them in.
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
      // REPLACED ON EVERY SETTLED RESTORE, an empty report and an absent record
      // included. The alternative shipped: a publish guarded on "there is something to
      // say" leaves the last session that had something to say saying it forever, which
      // is exactly the state a route between two open sessions produces. The publisher
      // is bound to the session this pass addressed, so a slow read that lands after the
      // route installs nothing rather than reporting into the session it arrived in.
      publishRestoreRefusals(report?.refusals ?? NO_RESTORE_REFUSALS);
      if (layout.snapshot().panes.length === 0) {
        // This surface's own empty state: the workspace shows the ledger alone, full
        // width.
        layout.open({ kind: "transcript" });
      }

      // Opened only now, so nothing above reached the store: every commit this block
      // made is either what the record already held or what the write below carries.
      restore.settle();
      if (readOutcome.outcome === "failed") {
        // NOTHING IS FILED OVER A RECORD THIS READ COULD NOT REACH. The pane layout on
        // screen is the fallback, or the fallback plus whatever the person did while
        // the read ran, and neither is an arrangement they asked to save — while the
        // record the adapter still holds is. Saving is not disabled by this: the
        // restore has SETTLED, so the subscription below files the person's next
        // deliberate change, and the next mount reads again.
        return;
      }
      if (actedDuringRead || (report?.restoredPaneCount ?? 0) === 0) {
        // ONCE, and only where the pane layout on screen is not what the record held: the
        // person's arrangement, or the fallback ledger this surface just opened.
        writer.request(sessionId, layout.toSnapshot());
      }
    })();
    return () => {
      superseded = true;
      // Abandoned before it landed, so the gate goes back: this pass adopted nothing,
      // and a pass that never reads again would leave the pane layout saving an arrangement it
      // never restored.
      restore.abandon();
    };
  }, [layout, publishRestoreRefusals, restore, sessionId, uiStateStore, writer]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return layout.subscribe(() => {
      // Nothing is written before the restore has landed. A write from the transient pane layout would
      // replace the very record the read above is still resolving, and the person would
      // find a first-run window where their arrangement had been.
      if (!restore.hasSettled) {
        return;
      }
      writer.request(sessionId, layout.toSnapshot());
    });
  }, [layout, restore, writer, sessionId]);

  return restoreRefusals.value;
}
