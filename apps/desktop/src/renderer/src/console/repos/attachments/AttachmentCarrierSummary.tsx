import { Nothing, formatCount } from "../../primitives/index.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";
import { EMPTY_CARRIER_TITLE } from "./attachment-carrier-copy.js";

/**
 * The collapsed line.
 *
 * A count of what the carrier holds rather than the section's name read back, on
 * `RepoSection.tsx`'s reason: the sidebar collapsed this section, so the one line of
 * room reports the fact that decision was made against.
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
  const refusedCount = entries.filter((entry) => entry.state === "refused").length;
  return (
    <span className="meridian-attachment-section__count">
      {formatCount(entries.length)} attached
      {refusedCount > 0 ? `, ${formatCount(refusedCount)} refused` : ""}
    </span>
  );
}
