import type { AttentionItem } from "@ai-sidekicks/contracts";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";

/**
 * One item.
 *
 * Rendered as a button when the caller supplied a way to open it and as plain
 * text otherwise, so the console never offers a press that goes nowhere. The
 * scope reads off `runId` exactly as the projection discriminates it: an item
 * carrying one is that run's, an item without one is the session's aggregate,
 * and the console labels which without recomputing either.
 *
 * The chip reads the item's state word as the projection wrote it: `Waiting on you`,
 * `Finished`, `Failed`, or a workflow's Notify step's own text. The banner main
 * posts says the same words, so the list keeps no wording of its own for them.
 * Exactly one trigger earns red and a glyph, the one that names a failure, so the
 * two-hue rule holds: amber means a person is needed, red means something failed.
 *
 * THE INSTANT CARRIES ITS DAY. Rows are grouped by SESSION and by nothing else —
 * there is no day divider anywhere in this list — so a clock-only reading would make
 * an item raised this afternoon and one raised last Tuesday at the same minute the
 * same eight characters, separated only by a hover title a keyboard never reaches.
 * `formatDateTime` is the console's formatter for exactly that case and says so in
 * its own words; the alternative is a divider this list cannot have, because its
 * one grouping axis is already spent on the session.
 */
export function NotificationEntry(props: {
  readonly item: AttentionItem;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { item, onOpen } = props;
  const body = (
    <>
      <span className="meridian-attention__row-head">
        {item.trigger === "run_failed" ? (
          <Chip tone="failure" label={item.stateWord} glyph="alert" />
        ) : (
          <Chip
            tone={item.severity === "actionable" ? "attention" : "neutral"}
            label={item.stateWord}
          />
        )}
        <WireFigure value={formatDateTime(item.createdAt)} title={item.createdAt} />
      </span>
      <span className="meridian-attention__row-summary">{item.summary}</span>
      <span className="meridian-attention__row-scope">
        {item.runId === undefined ? (
          "Everything unresolved in this session"
        ) : (
          <WireFigure value={item.runId} />
        )}
      </span>
    </>
  );
  if (onOpen === undefined) {
    return <div className="meridian-attention__row">{body}</div>;
  }
  return (
    <button
      type="button"
      className="meridian-attention__row meridian-attention__row--open"
      onClick={() => {
        onOpen(item);
      }}
    >
      {body}
    </button>
  );
}
