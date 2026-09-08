import { Nothing, formatCount } from "../../primitives/index.js";
import { attachmentCarrierFill } from "./attachment-bounds.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";
import { EMPTY_CARRIER_TITLE } from "./attachment-carrier-copy.js";

/**
 * What the carrier holds, against what it is allowed to hold.
 *
 * A count of what the carrier holds rather than the section's name read back, on
 * `RepoSection.tsx`'s reason: the sidebar collapsed this section, so the one line of
 * room reports the fact that decision was made against.
 *
 * THE DENOMINATOR IS THE POINT, and it used to be missing. `Spec-014 §Bounds (normative
 * defaults; operator-tunable)` caps a carrier at ten attachments and refuses the WHOLE
 * carrier at acceptance once it is past that, so "7 attached" and "7 of 10 attached"
 * are two different amounts of warning — and the first one leaves a participant to
 * discover the bound by hitting it. What happens at the bound is stated in the
 * affordance's own disclosure beside this line.
 *
 * IT IS A FIGURE AND NOT A GATE. Nothing here withdraws the picker or marks the carrier
 * full: the count bound is operator-tunable and the daemon is what enforces it, so a
 * console that stopped at ten would be deriving eligibility it does not own.
 *
 * RENDERED IN BOTH SHAPES OF THE SECTION — the collapsed line and, above the list, the
 * open one — because the count is the same fact either way and a second rendering of it
 * would be a second place to keep the denominator right.
 */
export function AttachmentCarrierSummary(props: {
  readonly entries: readonly AttachmentIngestEntry[];
}): React.JSX.Element {
  const { entries } = props;
  if (entries.length === 0) {
    // The summary is a paragraph, so the absence takes its inline shape: a block-shaped
    // absence would put a `<div>` inside a `<p>`, which the parser closes early.
    return <Nothing kind="empty" placement="inline" title={EMPTY_CARRIER_TITLE} />;
  }
  const fill = attachmentCarrierFill(entries.length);
  const refusedCount = entries.filter((entry) => entry.state === "refused").length;
  return (
    <span className="meridian-attachment-section__count">
      {formatCount(fill.attached)} of {formatCount(fill.allowance)} attached
      {refusedCount > 0 ? `, ${formatCount(refusedCount)} refused` : ""}
    </span>
  );
}
