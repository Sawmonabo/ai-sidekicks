import "./PayloadTable.css";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/document";

import { MarkdownDocumentRow } from "./MarkdownDocumentRow.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { useLastRowReadAhead } from "./hooks/useLastRowReadAhead.js";
import { usePayloadTableRows } from "./hooks/usePayloadTableRows.js";
import type { PayloadTableRow, PayloadValuePlace } from "./rows.js";
import { PayloadRowWindow } from "./PayloadRowWindow.js";

/**
 * A payload's items drawn by their type in the Table view, windowed to the rows in view. The list
 * holds only rows whose strings are read and keeps the room of the rest below it; its last drawn
 * row reads further, and so does a view that reaches into that room.
 */
export function PayloadTable(props: {
  readonly items: readonly WorkflowItem[];
  readonly label: string;
}): React.JSX.Element {
  const { rows, waitingHeightPx, readAhead } = usePayloadTableRows(props.items);
  return (
    <PayloadRowWindow
      rowCount={rows.length}
      roomBelow={{ heightPx: waitingHeightPx, onReached: readAhead }}
      label={props.label}
      className="meridian-workflow-payload__table"
      renderRow={(rowIndex) => {
        const row = rows[rowIndex];
        return row === undefined ? null : (
          <TableRow row={row} isLastRow={rowIndex === rows.length - 1} readAhead={readAhead} />
        );
      }}
    />
  );
}

function TableRow(props: {
  readonly row: PayloadTableRow;
  readonly isLastRow: boolean;
  readonly readAhead: (reachedPx?: number) => void;
}): React.JSX.Element {
  useLastRowReadAhead(props.isLastRow, props.readAhead);
  const { row } = props;
  switch (row.kind) {
    case "item":
      return (
        <p className="meridian-workflow-payload__item-head">
          <FigureSentence parts={row.heading} />
        </p>
      );
    case "file":
      return (
        <p className="meridian-workflow-payload__file">
          <FigureSentence parts={row.line} />
        </p>
      );
    case "value":
      return (
        <ValuePlace place={row.place}>
          <span className="meridian-workflow-payload__value">{row.text}</span>
        </ValuePlace>
      );
    case "markdown":
      return (
        <ValuePlace place={row.place}>
          <MarkdownDocumentRow row={row.row} context={row.context} />
        </ValuePlace>
      );
  }
}

/** A value under its member's name, which only a member's first row shows, or full width. */
function ValuePlace(props: {
  readonly place: PayloadValuePlace;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  if (props.place.kind === "whole") {
    return <div className="meridian-workflow-payload__whole">{props.children}</div>;
  }
  return (
    <div className="meridian-workflow-payload__member">
      <span>{props.place.key === undefined ? null : <WireFigure value={props.place.key} />}</span>
      <div className="meridian-workflow-payload__cell">{props.children}</div>
    </div>
  );
}
