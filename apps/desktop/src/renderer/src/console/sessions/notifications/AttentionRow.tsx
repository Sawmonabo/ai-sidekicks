import type { AttentionItem } from "../../bridge/index.js";
import { Chip, WireFigure, formatDateTime } from "../../primitives/index.js";
import type { AttentionTrigger } from "../../bridge/index.js";

/**
 * One item.
 *
 * Rendered as a button when the surface supplied a way to open it and as plain
 * text otherwise, so the console never offers a press that goes nowhere. The
 * scope reads off `runId` exactly as the projection discriminates it: an item
 * carrying one is that run's, an item without one is the session's aggregate,
 * and the console labels which without recomputing either.
 *
 * THE INSTANT CARRIES ITS DAY. Rows are grouped by SESSION and by nothing else —
 * there is no day divider anywhere on this surface — so a clock-only reading made
 * an item raised this afternoon and one raised last Tuesday at the same minute the
 * same eight characters, separated only by a hover title a keyboard never reaches.
 * `formatDateTime` is the console's formatter for exactly that case and says so in
 * its own words; the alternative is a divider this list cannot have, because its
 * one grouping axis is already spent on the session.
 */
export function AttentionRow(props: {
  readonly item: AttentionItem;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { item, onOpen } = props;
  const body = (
    <>
      <span className="meridian-attention__row-head">
        {item.trigger === "run_failed" ? (
          <Chip tone="failure" label={TRIGGER_LABELS[item.trigger]} glyph="alert" />
        ) : (
          <Chip
            tone={item.severity === "actionable" ? "attention" : "neutral"}
            label={TRIGGER_LABELS[item.trigger]}
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

/**
 * How one trigger reads. Total over the closed six by construction, so a seventh
 * fails to compile here before it can reach a surface that renders it namelessly.
 *
 * The label is the console's own reading of a wire value; the item's `summary` is
 * the projection's own text and is rendered beside it verbatim. Exactly one of the
 * six earns red and a glyph — the one that names a failure — so the two-hue rule
 * holds: amber means a person is needed, red means something failed, and every
 * other trigger carries whichever of those its severity says and no colour of its
 * own.
 */
export const TRIGGER_LABELS: Readonly<Record<AttentionTrigger, string>> = {
  pending_approval: "Waiting on an approval",
  pending_input: "Waiting on your input",
  run_completed: "A run finished",
  run_failed: "A run failed",
  invite_received: "An invitation arrived",
  mention: "You were mentioned",
};
