import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatAge, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";

/**
 * One entry, one line: a dot (waiting amber, done a hollow ring, failed a red mark), the name, the
 * daemon's state word verbatim and the age, whose hover label is the time it stands for. A button
 * when the caller supplied a way to open it, plain text otherwise, so the list never offers a
 * press that goes nowhere.
 */
export function NotificationEntry(props: {
  readonly item: AttentionItem;
  readonly nowMilliseconds: number;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { item, onOpen } = props;
  const clockLocale = useClockLocale();
  const body = (
    <>
      <span
        className={`meridian-attention__dot meridian-attention__dot--${entryState(item)}`}
        aria-hidden="true"
      />
      <span className="meridian-attention__name">{item.displayName}</span>
      <span className="meridian-attention__state">{item.stateWord}</span>
      <WireFigure
        value={formatAge(item.createdAt, props.nowMilliseconds)}
        hoverLabel={formatZonedDateTime(item.createdAt, clockLocale)}
      />
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

/** Which of the three dots an entry wears: actionable waits on the person, a failed run failed. */
function entryState(item: AttentionItem): "waiting" | "done" | "failed" {
  if (item.severity === "actionable") {
    return "waiting";
  }
  return item.trigger === "run_failed" ? "failed" : "done";
}
