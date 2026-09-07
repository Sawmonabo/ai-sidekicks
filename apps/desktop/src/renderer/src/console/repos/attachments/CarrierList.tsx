// Every attachment this carrier holds, in the position the participant put it — and
// the two ways that position is changed.
//
// AN ORDERED LIST, WHICH IS THE CLAIM THE SURFACE MAKES. `Spec-014 §Required Behavior`
// makes ordering caller-declared and preserved end to end, so the order is a fact about
// the carrier rather than the shape a renderer happened to emit — and an `<ol>` is what
// says so to a reader who cannot see it. It is also what makes "position 2 of 4" in the
// grip's own name a description of something on screen rather than an invention.
//
// THIS COMPONENT OWNS WHERE A MOVE LANDS AND THE ROW OWNS THE GESTURE. Both paths — a
// pointer drop on a row and an arrow key on a grip — arrive here as a request naming an
// attachment, and both are answered by `attachment-reorder.ts` and then performed by the
// carrier's single writer. Two answers to "where does this go" is how a drag and a key
// press come to disagree, and the list is the only place that holds the whole order.
//
// THE ANNOUNCEMENT IS MADE ONCE, HERE, and only for a move that happened. A key press
// at the end of the list moves nothing, and a drop on the row a drag started from moves
// nothing; neither says anything, because a live region reporting "moved to position 1
// of 4" about an attachment that is still where it was is worse than silence.

import { useCallback } from "react";

import { Nothing, useAnnounce } from "../../primitives/index.js";
import { CarrierRow } from "./CarrierRow.js";
import { attachmentNameReading } from "./attachment-provenance.js";
import {
  attachmentPositionOf,
  attachmentReorderAnnouncement,
  movedAttachmentPosition,
} from "./attachment-reorder.js";
import { type AttachmentIngestEntry } from "./attachment-shapes.js";
import { EMPTY_CARRIER_TITLE, EMPTY_CARRIER_DETAIL } from "./attachment-carrier-copy.js";

export interface CarrierListProps {
  readonly entries: readonly AttachmentIngestEntry[];
  readonly publishedAtMilliseconds: number;
  /** The per-attachment byte bound each row measures its own declared size against. */
  readonly maximumByteLength: number;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
  /** Put this attachment at this declared position. The carrier's ledger is the record. */
  readonly onReorder: (localId: string, toPosition: number) => void;
}

export function CarrierList(props: CarrierListProps): React.JSX.Element {
  const { entries, onReorder } = props;
  const announce = useAnnounce();

  /** Perform one move and say what it did, or do neither. */
  const moveTo = useCallback(
    (localId: string, toPosition: number | undefined) => {
      if (toPosition === undefined) {
        return;
      }
      const moved = entries.find((entry) => entry.declared.localId === localId);
      if (moved === undefined) {
        return;
      }
      onReorder(localId, toPosition);
      announce(
        attachmentReorderAnnouncement(
          attachmentNameReading(moved).name,
          toPosition,
          entries.length,
        ),
      );
    },
    [announce, entries, onReorder],
  );

  const moveBy = useCallback(
    (localId: string, offset: number) => {
      const fromPosition = attachmentPositionOf(entries, localId);
      if (fromPosition === undefined) {
        return;
      }
      moveTo(localId, movedAttachmentPosition(fromPosition, offset, entries.length));
    },
    [entries, moveTo],
  );

  const dropOnto = useCallback(
    (draggedLocalId: string, targetLocalId: string) => {
      moveTo(draggedLocalId, attachmentPositionOf(entries, targetLocalId));
    },
    [entries, moveTo],
  );

  if (entries.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={EMPTY_CARRIER_TITLE}
        detail={EMPTY_CARRIER_DETAIL}
      />
    );
  }
  return (
    <ol className="meridian-carrier-list">
      {entries.map((entry, position) => (
        <CarrierRow
          key={entry.declared.localId}
          entry={entry}
          position={position}
          attachmentCount={entries.length}
          maximumByteLength={props.maximumByteLength}
          publishedAtMilliseconds={props.publishedAtMilliseconds}
          onRetry={props.onRetry}
          onAbandon={props.onAbandon}
          onMoveBy={moveBy}
          onDropOnto={dropOnto}
        />
      ))}
    </ol>
  );
}
