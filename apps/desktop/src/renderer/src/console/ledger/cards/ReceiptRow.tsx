// The row for an event that carries no body.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and the reason that rule bites here rather than being a formality: this row
// is what the overwhelming majority of the event taxonomy renders as, and while it
// sat private inside the fixture shell's switch it was reachable only through that
// switch — so a test for the empty-summary line had to build a whole shell row to
// get at one paragraph, and a family looking for "what a receipt looks like" had no
// file to open.

import { LedgerRow, Nothing } from "../../primitives/index.js";
import { type TimelineRowSlotProps } from "../../seats/index.js";

/**
 * A row that carries no body: one line, stating what happened.
 *
 * The line is the row's own wire summary and nothing else. A summary that is empty
 * says so by name rather than rendering as a blank line a reader would scroll past.
 */
export function ReceiptRow(props: TimelineRowSlotProps): React.JSX.Element {
  return (
    <LedgerRow
      participantHueStep={props.participantHue?.step ?? -1}
      {...(props.participantHue === undefined
        ? {}
        : { ringTreatment: props.participantHue.ringTreatment })}
      occurredAtIso={props.row.timestamp}
      actorLabel={props.row.actor ?? "Session"}
      kindLabel={props.row.type}
      isSuperseded={props.isSuperseded}
    >
      {props.row.summary === "" ? (
        <Nothing kind="empty" placement="inline" title="This event carries no summary." />
      ) : (
        <p className="meridian-receipt-row">{props.row.summary}</p>
      )}
    </LedgerRow>
  );
}
