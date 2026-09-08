// The bar that appears when rows are selected: what is selected, and what can be done
// to it.
//
// IT OFFERS ONE BUTTON PER ACT IN THE SELECTION, and never one button per act that
// exists. A selection of three queued items and two invites offers two buttons, each
// naming its own count; an act nothing is selected for is not drawn, because a control
// that would run over no rows is a control that answers nothing.
//
// IT DERIVES NO ELIGIBILITY. Whether the daemon will admit a cancel, a revoke, or a
// retire is the daemon's to say — the control is offered, the call goes out, and the
// refusal renders per row. This is the same fail-closed posture the sections are held
// to, read from the other side: the renderer's job is to ask, not to pre-judge.
//
// THE RUN IS ALWAYS PREVIEWED. Pressing an act button opens the confirm; nothing here
// calls the runner directly. All three acts are destructive, so there is no second
// path, which is what keeps the preview from being something a fourth act could forget.
//
// AND THE PREVIEW BELONGS TO THE SELECTION IT WAS OPENED OVER. The model handed down is
// re-minted with the session and this bar is not remounted around it, so a pending act
// held for the life of the MOUNT outlived the rows it was staged for: the preview
// re-read `selectedFor` against the arriving model and drew the NEW session's rows
// under a confirm nobody had opened for them, one press from running over them. It goes
// through `store/subject-scoped-state.ts` on the model, which is the subject the whole
// question is about — the pass that first sees a new one already reads no pending act,
// so no frame ever carries the stale confirm.

import { type ConsoleBridge } from "../../../bridge/index.js";
import { DerivedFigure } from "../../../primitives/index.js";
import { type SidebarBulkAct } from "../../../seats/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import { SIDEBAR_BULK_ACT_DESCRIPTORS } from "./bulk-acts.js";
import { runBulkAct } from "./bulk-runner.js";
import { type BulkSelectionModel } from "./bulk-selection.js";
import { BulkConfirmDialog } from "./BulkConfirmDialog.js";
import { BulkOutcomeList, type BulkOutcomeRow } from "./BulkOutcomeList.js";
import { useBulkSelectionSnapshot } from "./use-bulk-selection.js";

export interface BulkActionBarProps {
  readonly model: BulkSelectionModel;
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}

export function BulkActionBar(props: BulkActionBarProps): React.JSX.Element | null {
  const snapshot = useBulkSelectionSnapshot(props.model);
  const { value: confirmingAct, publish: publishConfirmingAct } = useSubjectScopedState<
    SidebarBulkAct | undefined
  >(props.model, undefined, () => undefined);

  const outcomeRows: readonly BulkOutcomeRow[] = [...snapshot.outcomeByItemKey].flatMap(
    ([itemKey, outcome]) => {
      const item = snapshot.settledItemByKey.get(itemKey);
      return item === undefined ? [] : [{ item, outcome }];
    },
  );
  const confirmingItems = confirmingAct === undefined ? [] : props.model.selectedFor(confirmingAct);

  if (snapshot.selectedItems.length === 0 && outcomeRows.length === 0) {
    return null;
  }

  return (
    <div className="meridian-sidebar-bulk" role="group" aria-label="Bulk operations">
      {snapshot.selectedItems.length === 0 ? null : (
        <div className="meridian-sidebar-bulk__selection">
          <DerivedFigure text={`${String(snapshot.selectedItems.length)} selected`} />
          {props.model.selectedActs().map((act) => (
            <button
              key={act}
              type="button"
              className="meridian-sidebar-bulk__act"
              onClick={() => {
                publishConfirmingAct(act);
              }}
            >
              {SIDEBAR_BULK_ACT_DESCRIPTORS[act].label} (
              {String(props.model.selectedFor(act).length)})
            </button>
          ))}
          <button
            type="button"
            className="meridian-sidebar-bulk__clear"
            onClick={() => {
              props.model.clearSelection();
            }}
          >
            Clear selection
          </button>
        </div>
      )}
      {confirmingAct === undefined ? null : (
        <BulkConfirmDialog
          items={confirmingItems}
          onCancel={() => {
            publishConfirmingAct(undefined);
          }}
          onConfirm={() => {
            publishConfirmingAct(undefined);
            // Not awaited: every row files its own outcome as it lands, and a bar that
            // waited for the whole fan-out would be a bar showing nothing until the
            // slowest reply — which is the sequential-and-silent shape the design track
            // forbids, arrived at from the other direction.
            void runBulkAct({
              model: props.model,
              bridge: props.bridge,
              sessionId: props.sessionId,
              act: confirmingAct,
            });
          }}
        />
      )}
      <BulkOutcomeList
        rows={outcomeRows}
        onDismiss={() => {
          props.model.clearOutcomes();
        }}
      />
    </div>
  );
}
