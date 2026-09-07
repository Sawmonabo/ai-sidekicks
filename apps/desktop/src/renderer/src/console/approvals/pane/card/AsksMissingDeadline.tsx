// The count of asks the list is holding that carry no deadline.
//
// Split from `ApprovalList.tsx`, which owns ordering and the list body, while this
// owns one disclosure about it.
//
// A MISSING DEADLINE IS REPORTED, NEVER SYNTHESISED. The list cannot order what it
// cannot date, so these rows are named as a group rather than given an invented
// expiry that would sort them somewhere they do not belong.

import { formatCount } from "../../../primitives/index.js";

/**
 * The one line this list says about asks whose deadline never arrived.
 *
 * Said once above the list rather than badged on each card, because the list already
 * has a place where it reports what it could not fully use — and a per-card badge
 * would repeat the same sentence while still leaving the summary above claiming
 * everything below it was whole.
 */
export function AsksMissingDeadline(props: { readonly count: number }): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <p className="meridian-approvals__unreadable">
      {formatCount(props.count)} of these were raised by a provider without the deadline the wire
      carries beside the ask, so no expiry is shown for them.
    </p>
  );
}
