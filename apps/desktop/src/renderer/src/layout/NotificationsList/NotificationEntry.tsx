import type { AttentionItem } from "@ai-sidekicks/contracts";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";

/**
 * One attention item: a button when the caller supplied a way to open it, plain text otherwise, so
 * the console never offers a press that goes nowhere. The scope reads off `runId` as the
 * projection discriminates it (a run's item, or the session's aggregate). The chip shows the
 * projection's state word verbatim; only the failure trigger takes red and a glyph. The timestamp
 * carries its date because rows group by session, with no day divider.
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
