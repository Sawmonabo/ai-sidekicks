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
//
// AND THE ROW TAKES THE WHOLE READING BECAUSE THE BOUND ALONE CANNOT BE STATED HONESTLY.
// `attachment-bounds.ts` carries `source` beside the figure precisely because an
// operator override replaces the shipped default WHOLESALE, and the only reader the
// affordance has today answers `shipped-default` on every build the console runs on. A
// row handed a bare number said "this deployment admits" about a figure no deployment
// had reported, and then rendered the refusal's own past-tense copy — "Nothing was
// stored" — above a file the daemon had not been asked about. So both halves of this
// row are keyed on `source`: the allowance line qualifies whose bound it is showing,
// and the over-allowance region renders a REFUSAL where the figure is the deployment's
// and a FORECAST where it is the shipped default. The forecast is minted beside the
// refusal table (`artifacts/artifact-refusal-copy.ts`) and carries that entry's own
// three bounds, so the two readings cannot drift apart.

import { useState } from "react";

import { Glyph, RefusalRecovery } from "../../primitives/index.js";
import { DerivedFigure, WireFigure, formatByteQuantity } from "../../primitives/index.js";
import { GLYPH_SIZE_DENSE } from "../../tokens/index.js";
import { AttachmentCard } from "./AttachmentCard.js";
import {
  exceedsAttachmentByteAllowance,
  type AttachmentAllowlistReading,
} from "./attachment-bounds.js";
import { attachmentNameReading } from "./attachment-provenance.js";
import {
  ARTIFACT_TOO_LARGE_FORECAST,
  TOO_LARGE_CODE,
  artifactRefusalRecovery,
} from "../artifacts/artifact-refusal-copy.js";
import { attachmentReorderHandleLabel } from "./attachment-reorder.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";
import { useCarrierRowDrag } from "./carrier-drag.js";

/** How far one arrow-key press moves an attachment, in declared positions. */
const MOVE_EARLIER = -1;
const MOVE_LATER = 1;

/**
 * What the allowance line says the figure beside it IS, per arm of the reading.
 *
 * Two sentences and not one with a clause bolted on, because they make different
 * claims: one reports a bound the daemon answered with, and the other reports the
 * bound this console ships with and says where the real one is settled. A line that
 * could not tell them apart would be a claim about a deployment nothing has read.
 */
const EFFECTIVE_ALLOWANCE_NOTE = "this deployment admits per attachment";
const SHIPPED_DEFAULT_ALLOWANCE_NOTE =
  "this console ships as the default per attachment. What this deployment admits is settled at ingest";

export interface CarrierRowProps {
  readonly entry: AttachmentIngestEntry;
  readonly position: number;
  readonly attachmentCount: number;
  /**
   * The bounds this row measures against, WITH where they came from.
   *
   * The whole reading and never the number off it: `source` is what decides both what
   * the allowance line claims and whether the region below it is a refusal or a
   * forecast, and a row handed the figure alone could only guess.
   */
  readonly allowlist: AttachmentAllowlistReading;
  readonly publishedAtMilliseconds: number;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
  /** Move this attachment by one position. The list decides whether there is room. */
  readonly onMoveBy: (localId: string, offset: number) => void;
  /** A pointer drop landed on this row; the dragged attachment takes its position. */
  readonly onDropOnto: (draggedLocalId: string, targetLocalId: string) => void;
}

export function CarrierRow(props: CarrierRowProps): React.JSX.Element {
  const { entry, position, attachmentCount, allowlist } = props;
  const { maximumByteLength } = allowlist;
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
          <DerivedFigure
            text={
              allowlist.source === "effective"
                ? EFFECTIVE_ALLOWANCE_NOTE
                : SHIPPED_DEFAULT_ALLOWANCE_NOTE
            }
          />
        </p>
        {isOverAllowance ? renderOverAllowance(allowlist.source) : null}
      </div>
    </li>
  );
}

/**
 * What a row past the bound says — which depends on WHOSE bound it is past.
 *
 * A render helper rather than a branch inside the body, on `ArtifactRefusalRecovery`'s
 * rule: it holds no state and takes no hooks, so an element type would buy a
 * reconciliation boundary nothing needs, and the two arms are long enough that inline
 * they hid which of them a reader was in.
 *
 * THE EFFECTIVE ARM RENDERS THE REFUSAL WHOLE. The table's `too_large` entry is a
 * meaning, a lead-in, and the three bounds that lead-in promises — so a surface
 * rendering only the meaning and the lead-in ends on a colon and names none of them.
 * The shell that renders a recovery everywhere else renders it here too, which is what
 * keeps this warning the refusal's own words rather than a paraphrase that drifts.
 *
 * THE SHIPPED-DEFAULT ARM RENDERS THE FORECAST, and carries no past-tense sentence at
 * all: the figure being measured against is this console's own, no deployment has
 * reported one, and nothing has been sent — so "Nothing was stored" would be a report
 * of a refusal that has not been asked for. The forecast is the same three bounds under
 * a conditional lead-in, and it carries no `meaning`, whose closing clause points at a
 * daemon sentence this arm does not have.
 */
function renderOverAllowance(
  source: AttachmentAllowlistReading["source"],
): React.JSX.Element | null {
  if (source === "shipped-default") {
    return (
      <div className="meridian-carrier-row__over-allowance" role="status">
        <RefusalRecovery recovery={ARTIFACT_TOO_LARGE_FORECAST} />
      </div>
    );
  }
  const refusalCopy = artifactRefusalRecovery(TOO_LARGE_CODE);
  if (refusalCopy === undefined) {
    return null;
  }
  return (
    <div className="meridian-carrier-row__over-allowance" role="status">
      {refusalCopy.meaning === undefined ? null : <p>{refusalCopy.meaning}</p>}
      <RefusalRecovery recovery={refusalCopy} />
    </div>
  );
}
