import "./PayloadTable.css";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/definition";

import { MarkdownDocumentRow } from "@renderer/components/Markdown/MarkdownDocumentRow.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { useDrawnStringRead } from "./hooks/useDrawnStringRead.js";
import { usePayloadTableRows } from "./hooks/usePayloadTableRows.js";
import type { PayloadTableRow, PayloadValuePlace } from "./payload-rows.js";
import { PAYLOAD_ROW_ESTIMATE_PX, PayloadRowWindow } from "./PayloadRowWindow.js";

/** A payload's items drawn by their type in the Table view, windowed to the rows in view. */
export function PayloadTable(props: {
  readonly items: readonly WorkflowItem[];
  readonly label: string;
}): React.JSX.Element {
  const { rows, readString } = usePayloadTableRows(props.items);
  return (
    <PayloadRowWindow
      rowCount={rows.length}
      label={props.label}
      className="meridian-workflow-payload__table"
      estimateRowHeightPx={(rowIndex) => {
        const row = rows[rowIndex];
        return row?.kind === "unread" ? unreadRowHeightPx(row.lineCount) : PAYLOAD_ROW_ESTIMATE_PX;
      }}
      renderRow={(rowIndex) => {
        const row = rows[rowIndex];
        return row === undefined ? null : <TableRow row={row} readString={readString} />;
      }}
    />
  );
}

function TableRow(props: {
  readonly row: PayloadTableRow;
  readonly readString: (stringIndex: number) => void;
}): React.JSX.Element {
  const { row } = props;
  switch (row.kind) {
    case "unread":
      return (
        <UnreadRow
          stringIndex={row.stringIndex}
          lineCount={row.lineCount}
          readString={props.readString}
        />
      );
    case "item":
      return <p className="meridian-workflow-payload__item-head">{row.heading}</p>;
    case "file":
      return (
        <p className="meridian-workflow-payload__file">
          <WireFigure value={row.line} />
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
      <span className="meridian-workflow-payload__key">
        {props.place.key === undefined ? null : <WireFigure value={props.place.key} />}
      </span>
      <div className="meridian-workflow-payload__cell">{props.children}</div>
    </div>
  );
}

/**
 * A string's place before it is read, as tall as its lines would draw. It is read before the
 * frame paints, so this is never seen.
 */
function UnreadRow(props: {
  readonly stringIndex: number;
  readonly lineCount: number;
  readonly readString: (stringIndex: number) => void;
}): React.JSX.Element {
  useDrawnStringRead(props.stringIndex, props.readString);
  return <div style={{ blockSize: unreadRowHeightPx(props.lineCount) }} />;
}

function unreadRowHeightPx(lineCount: number): number {
  return lineCount * PAYLOAD_ROW_ESTIMATE_PX;
}
