import { memo } from "react";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/document";

import { usePayloadJsonRow } from "./hooks/usePayloadJsonRow.js";
import { payloadJsonRowCount } from "./rows.js";
import { PayloadRowWindow } from "./PayloadRowWindow.js";

/**
 * A payload in the JSON view: the items exactly as stored, one item to a row, windowed to the
 * rows in view. The rows read together are the stored JSON, line breaks included; an item is
 * stringified only while its row is drawn. Drawn inside `StepPayload`, whose sheet holds its class.
 */
export function PayloadJson(props: {
  readonly items: readonly WorkflowItem[];
  readonly label: string;
}): React.JSX.Element {
  return (
    <PayloadRowWindow
      rowCount={payloadJsonRowCount(props.items)}
      label={props.label}
      className="meridian-workflow-payload__json"
      renderRow={(rowIndex) => <JsonRow items={props.items} rowIndex={rowIndex} />}
    />
  );
}

/** One drawn row, kept while it stays drawn, so a scroll does not stringify it again. */
const JsonRow = memo(function JsonRow(props: {
  readonly items: readonly WorkflowItem[];
  readonly rowIndex: number;
}): React.JSX.Element {
  return <>{usePayloadJsonRow(props.items, props.rowIndex)}</>;
});
