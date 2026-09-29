// The pane's error strip: the refusals the transcript collected, in rank order.
//
// A row that threw while being drawn is a different failure, caught by the shared error
// boundary with `TranscriptRowGroup` as its fallback.

import { InlineRefusal, RefusalCard } from "@renderer/console/primitives/index.js";
import { type LedgerErrorEntry } from "../transcript-errors.js";

/** The occupied slots, and the action for the highest one. */
export interface LedgerErrorSlotProps {
  readonly entries: readonly LedgerErrorEntry[];
  /** The operator's next move for the highest-ranked slot, when there is one. */
  readonly action?: React.ReactNode;
}

/**
 * The highest-ranked slot as a card, the one a person is meant to act on; the rest
 * inline, as context for it. Four cards would bury the log the pane exists to show.
 */
export function LedgerErrorSlot(props: LedgerErrorSlotProps): React.JSX.Element | null {
  const [highest, ...rest] = props.entries;
  if (highest === undefined) {
    return null;
  }
  return (
    <div className="meridian-ledger-errors">
      <RefusalCard
        code={highest.refusal.code}
        detail={highest.refusal.detail}
        action={props.action}
      />
      {rest.map((entry) => (
        <InlineRefusal key={entry.kind} code={entry.refusal.code} detail={entry.refusal.detail} />
      ))}
    </div>
  );
}
