// One attachment in the carrier, with the grip that moves it and the bound its own
// size is measured against.
//
// A COMPONENT RATHER THAN A BRANCH INSIDE THE LIST, because a row now holds state of
// its own: the drag adapter has to be handed this row's element and this row's grip,
// and it answers per row whether a drop is hovering it. A list that bound N rows from
// one component body would need N refs and N effects written by hand, which is the
// shape a component already is.
//
// THE GRIP IS ONE CONTROL SERVING BOTH PATHS. The adopted drag library publishes no
// keyboard drag by design and says the same outcome belongs on an ordinary control with
// an announcement beside it; a pair of move-up / move-down buttons on every row would
// be two more controls per attachment for an interaction most people perform with a
// pointer. So the grip is the drag handle AND the arrow-key target, and its accessible
// name says both.
//
// THE SIZE LINE IS THE BOUND STATED AHEAD OF THE REFUSAL. `core/constants.ts` gives the
// reason the console carries these figures at all: to explain a bound before a
// participant spends an upload earning it. The declared length here is the payload's
// own `Blob` size rather than a caller's claim, and when it is past the bound the row
// says what `artifact.too_large` will say — as a warning, never as a gate. Nothing here
// refuses to send: the three enforcement points are the daemon's.

import { useState } from "react";

import { Glyph } from "../../primitives/index.js";
import { DerivedFigure, WireFigure, formatByteQuantity } from "../../primitives/index.js";
import { GLYPH_SIZE_DENSE } from "../../tokens/index.js";
import { AttachmentCard } from "./AttachmentCard.js";
import { exceedsAttachmentByteAllowance } from "./attachment-bounds.js";
import { attachmentNameReading } from "./attachment-provenance.js";
import { TOO_LARGE_CODE, artifactRefusalRecovery } from "../artifacts/artifact-refusal-copy.js";
import { attachmentReorderHandleLabel } from "./attachment-reorder.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";
import { useCarrierRowDrag } from "./carrier-drag.js";

/** How far one arrow-key press moves an attachment, in declared positions. */
const MOVE_EARLIER = -1;
const MOVE_LATER = 1;

export interface CarrierRowProps {
  readonly entry: AttachmentIngestEntry;
  readonly position: number;
  readonly attachmentCount: number;
  /** The per-attachment byte bound this deployment admits, as read or as shipped. */
  readonly maximumByteLength: number;
  readonly publishedAtMilliseconds: number;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
  /** Move this attachment by one position. The list decides whether there is room. */
  readonly onMoveBy: (localId: string, offset: number) => void;
  /** A pointer drop landed on this row; the dragged attachment takes its position. */
  readonly onDropOnto: (draggedLocalId: string, targetLocalId: string) => void;
}

export function CarrierRow(props: CarrierRowProps): React.JSX.Element {
  const { entry, position, attachmentCount, maximumByteLength } = props;
  const [rowElement, setRowElement] = useState<HTMLLIElement | null>(null);
  const [handleElement, setHandleElement] = useState<HTMLButtonElement | null>(null);
  const localId = entry.declared.localId;
  const dragState = useCarrierRowDrag({
    localId,
    rowElement,
    handleElement,
    onDropOnto: props.onDropOnto,
  });
  const attachmentName = attachmentNameReading(entry).name;
  const declaredFigure = formatByteQuantity(entry.declared.byteLength);
  const allowanceFigure = formatByteQuantity(maximumByteLength);
  const isOverAllowance = exceedsAttachmentByteAllowance(
    entry.declared.byteLength,
    maximumByteLength,
  );
  const overAllowanceCopy = artifactRefusalRecovery(TOO_LARGE_CODE);
  return (
    <li
      // The element the adapter drags a preview of, held as STATE rather than in a ref:
      // the binding effect below has to run when the node arrives, and a ref assignment
      // does not re-run an effect.
      ref={setRowElement}
      className="meridian-carrier-row"
      data-dragging={dragState.isDragging ? "true" : undefined}
      data-drop-target={dragState.isDropTarget ? "true" : undefined}
    >
      <button
        ref={setHandleElement}
        type="button"
        className="meridian-carrier-row__grip"
        aria-label={attachmentReorderHandleLabel(attachmentName, position, attachmentCount)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            props.onMoveBy(localId, MOVE_EARLIER);
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            props.onMoveBy(localId, MOVE_LATER);
          }
        }}
      >
        <Glyph name="fold" size={GLYPH_SIZE_DENSE} />
      </button>
      <div className="meridian-carrier-row__body">
        <AttachmentCard
          reading={{ kind: "ingesting", entry }}
          nowMilliseconds={props.publishedAtMilliseconds}
          onRetry={props.onRetry}
          onAbandon={props.onAbandon}
        />
        <p className="meridian-carrier-row__allowance">
          <WireFigure value={declaredFigure.text} title={String(entry.declared.byteLength)} />
          <DerivedFigure text="of the" />
          <WireFigure value={allowanceFigure.text} title={String(maximumByteLength)} />
          <DerivedFigure text="this deployment admits per attachment" />
        </p>
        {isOverAllowance && overAllowanceCopy?.meaning !== undefined ? (
          <p className="meridian-carrier-row__over-allowance" role="status">
            {overAllowanceCopy.meaning} {overAllowanceCopy.nextMove}
          </p>
        ) : null}
      </div>
    </li>
  );
}
