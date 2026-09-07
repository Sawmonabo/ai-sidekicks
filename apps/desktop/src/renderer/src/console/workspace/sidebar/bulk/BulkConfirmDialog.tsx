// The destructive preview: what is about to happen, to exactly which rows.
//
// `Spec-023 §Console Design (Meridian)` §The surface set: "Destructive bulk operations
// preview the whole set and require confirm on the preview." All three acts are
// destructive, so every run passes through here — there is no non-previewed arm to get
// wrong.
//
// IT NAMES EVERY ITEM, NOT A COUNT. "Retire 4 worktrees" is a number a person has to
// trust; the list is the thing they can check. The count is stated too, because a list
// longer than the eye can hold still needs its size said once.
//
// IT CLAIMS THE AIRSPACE. `workspace/deck/rect-discipline.ts` holds the registry every
// overlay registers in so a native view yields while one is up; a dialog that did not
// claim it would be drawn under the browser pane's `WebContentsView`, which is not a
// z-index this renderer can win. The registry is OPTIONAL here for the same reason the
// deck's tracker takes it optionally: a column mounted without one is a column with no
// native views under it, and claiming a registry that does not exist is not a state.
//
// THE ESCAPE HATCH IS THE PLATFORM'S. Escape cancels and the initial focus lands on
// the cancelling control, so the destructive button is never what a stray Enter hits.

import { useEffect, useRef } from "react";

import { type SidebarBulkItem } from "../../../seats/index.js";
import { type AirspaceRegistry } from "../../deck/rect-discipline.js";
import { SIDEBAR_BULK_ACT_DESCRIPTORS } from "./bulk-acts.js";

/** The one overlay id this dialog claims the airspace under. */
const BULK_CONFIRM_AIRSPACE_ID = "sidebar-bulk-confirm";

export interface BulkConfirmDialogProps {
  /** The rows the act will run over, in the order they were selected. */
  readonly items: readonly SidebarBulkItem[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly airspace?: AirspaceRegistry;
}

export function BulkConfirmDialog(props: BulkConfirmDialogProps): React.JSX.Element | null {
  const cancelReference = useRef<HTMLButtonElement | null>(null);
  const { airspace } = props;

  useEffect(() => {
    if (airspace === undefined) {
      return;
    }
    return airspace.claim(BULK_CONFIRM_AIRSPACE_ID);
  }, [airspace]);

  useEffect(() => {
    cancelReference.current?.focus();
  }, []);

  const firstItem = props.items[0];
  if (firstItem === undefined) {
    // A confirm over nothing is not a question. The bar does not open one, and this
    // arm is what makes that true rather than assumed — a selection emptied while the
    // dialog was up would otherwise leave a confirm whose act would run over no rows.
    return null;
  }
  const descriptor = SIDEBAR_BULK_ACT_DESCRIPTORS[firstItem.act];

  return (
    <div
      className="meridian-sidebar-bulk__confirm"
      role="dialog"
      aria-modal={true}
      aria-label={`${descriptor.confirmVerb} the selected rows`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <p className="meridian-sidebar-bulk__confirm-summary">
        {descriptor.describe(props.items.length)}
      </p>
      <ul className="meridian-sidebar-bulk__confirm-items">
        {props.items.map((item) => (
          <li key={`${item.sectionId}:${item.act}:${item.itemId}`}>{item.label}</li>
        ))}
      </ul>
      <div className="meridian-sidebar-bulk__confirm-controls">
        <button
          type="button"
          ref={cancelReference}
          className="meridian-sidebar-bulk__confirm-cancel"
          onClick={() => {
            props.onCancel();
          }}
        >
          Keep them
        </button>
        <button
          type="button"
          className="meridian-sidebar-bulk__confirm-run"
          onClick={() => {
            props.onConfirm();
          }}
        >
          {descriptor.confirmVerb}
        </button>
      </div>
    </div>
  );
}
