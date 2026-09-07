// One sidebar arrangement per session, restored once and kept saved.
//
// THE RESTORE HAPPENS ONCE AND THE SAVE WAITS FOR IT. Exactly the ordering
// `layout-persistence.ts` states for the deck, and for the same failure: a save that
// fired before the restore completed would file the sidebar's opening defaults over
// the arrangement it was about to read, and the result looks identical to a first run.
//
// AND THE SAVE COALESCES THROUGH THE SAME WRITER THE DECK USES. Dragging the
// workspace's separator commits a width per frame; one durable write per frame would
// spend the store's whole budget on a gesture.
//
// THE MODEL IS PER SESSION. The collapsed set is written under the session's partition,
// so a model carried across a session switch would show the previous session's shape
// and then write it back under the new session's key. Re-minting it on the session is
// what makes the restore's own bookkeeping small: a fresh model has decided nothing,
// so decision 4 has only the acts made since THIS session opened to re-impose.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { type ConsoleRefusal } from "../../../core/index.js";
import { type UiStateStore } from "../../../persistence/index.js";
import { useSubjectScopedResource, useSubjectScopedState } from "../../../store/index.js";
import { RestoreProgress, refuseWorkspace } from "../../layout/layout-persistence.js";
import {
  CoalescingLayoutWriter,
  WRITER_RETIREMENT,
  type PersistedLayoutRecord,
} from "../../layout/layout-writer.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  SIDEBAR_LAYOUT_RECORD_KEY,
  decodeSidebarLayout,
  encodeSidebarLayout,
} from "../model/sidebar-layout-record.js";
import { SidebarModel, type SidebarSnapshot } from "../model/sidebar-model.js";

export interface SidebarPersistenceOptions {
  readonly uiStateStore: UiStateStore;
  /** `undefined` on a route that names no session, where nothing is kept. */
  readonly sessionId: string | undefined;
  readonly onSaveRefused: (refusal: ConsoleRefusal) => void;
}

/**
 * The model and its current snapshot together.
 *
 * Both, because every caller needs both — the acts to dispatch and the state to render
 * — and handing back only the model would make each caller subscribe for itself.
 */
export function useSidebarLayout(options: SidebarPersistenceOptions): {
  readonly model: SidebarModel;
  readonly snapshot: SidebarSnapshot;
} {
  const { uiStateStore, sessionId, onSaveRefused } = options;
  const model = useMemo(() => new SidebarModel(), [sessionId]);
  // Held per store, for the reason `layout-persistence.ts` states about the deck's: the
  // `UiStateStore` handed down is replaced on a reconnect without remounting this
  // surface, and a writer that closed over the first one would go on filing the
  // sidebar's arrangement into a store nothing reads again.
  const { value: writer } = useSubjectScopedResource<CoalescingLayoutWriter<PersistedLayoutRecord>>(
    uiStateStore,
    undefined,
    () =>
      new CoalescingLayoutWriter<PersistedLayoutRecord>({
        write: async (partition, snapshot) => {
          const result = await uiStateStore.write(
            partition,
            SIDEBAR_LAYOUT_RECORD_KEY,
            "layout",
            snapshot,
          );
          if (result.outcome === "refused") {
            onSaveRefused(result.refusal);
          }
        },
        onFailed: () => {
          onSaveRefused(
            refuseWorkspace(
              "layout-save-failed",
              "This window's sidebar arrangement could not be saved. It is still on screen, and it will be saved again on the next change.",
            ),
          );
        },
      }),
    // The terminal arm: `flushAndClose` is ONE-WAY, and the reading beside it is how
    // the holder tells a retired writer from a live one after React's double-mount
    // rather than re-committing a writer that drops every later request in silence.
    WRITER_RETIREMENT,
  );

  // Once per `(model, session)`. The model is re-minted with the session, so this gate
  // is re-armed with it and a second pass over a live model never re-reads.
  const { value: restore } = useSubjectScopedState(model, sessionId, () => new RestoreProgress());

  useEffect(() => {
    if (sessionId === undefined || !restore.isUnstarted) {
      return;
    }
    restore.start();
    let superseded = false;
    void (async () => {
      const record = await uiStateStore.read(sessionId, SIDEBAR_LAYOUT_RECORD_KEY);
      if (superseded) {
        return;
      }
      const decoded =
        record === undefined
          ? { state: INITIAL_SIDEBAR_LAYOUT_STATE, refusals: [] }
          : decodeSidebarLayout(record.value);
      const differsFromRecord = model.restore(decoded);

      // OPENED ONLY NOW, WHICH IS THE DECK'S ORDERING AND NOT A SECOND ONE. `restore`
      // publishes unconditionally — replacing the three durable axes is its whole job —
      // so a gate opened above it would fire the subscription below with the record it
      // had just read, and every session a person opened would spend a durable write
      // echoing that record back.
      restore.settle();
      if (differsFromRecord) {
        // ONCE, and only where what the person is looking at is not what the record
        // held: an act made during the read, or an arrangement the decode narrowed.
        writer.request(sessionId, encodeSidebarLayout(model.snapshot.state));
      }
    })();
    return () => {
      superseded = true;
      restore.abandon();
    };
  }, [model, restore, sessionId, uiStateStore, writer]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return model.subscribe((snapshot) => {
      // Nothing is written before the restore has landed, which is the ordering the
      // deck's own persistence states: a save from the opening defaults would file them
      // over the record this effect is still reading.
      if (!restore.hasSettled) {
        return;
      }
      writer.request(sessionId, encodeSidebarLayout(snapshot.state));
    });
  }, [model, restore, sessionId, writer]);

  const snapshot = useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.snapshot,
  );

  return { model, snapshot };
}
