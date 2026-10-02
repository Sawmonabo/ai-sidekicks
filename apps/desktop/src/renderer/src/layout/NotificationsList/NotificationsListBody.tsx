import type { AttentionItem } from "@ai-sidekicks/contracts";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { NotificationEntryList } from "./NotificationEntryList.js";

/**
 * The list body: a `Waiting on you` group with its count over an `Earlier` group, newest first in
 * each. A group with no entries is not drawn, and with no entries at all nothing is drawn.
 */
export function NotificationsListBody(props: {
  readonly reading: AttentionReading;
  readonly nowMilliseconds: number;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element | null {
  if (props.reading.phase === "reading") {
    return null;
  }
  const newestFirst = [...props.reading.summary.liveItems].reverse();
  const waiting = newestFirst.filter((item) => item.severity === "actionable");
  const earlier = newestFirst.filter((item) => item.severity !== "actionable");
  if (waiting.length === 0 && earlier.length === 0) {
    return null;
  }
  return (
    <>
      {waiting.length === 0 ? null : (
        <section className="meridian-attention__group" aria-label="Waiting on you">
          <h3 className="meridian-attention__group-title">
            Waiting on you <span>{formatCount(waiting.length)}</span>
          </h3>
          <NotificationEntryList
            items={waiting}
            nowMilliseconds={props.nowMilliseconds}
            onOpen={props.onOpen}
          />
        </section>
      )}
      {earlier.length === 0 ? null : (
        <section className="meridian-attention__group" aria-label="Earlier">
          <h3 className="meridian-attention__group-title">Earlier</h3>
          <NotificationEntryList
            items={earlier}
            nowMilliseconds={props.nowMilliseconds}
            onOpen={props.onOpen}
          />
        </section>
      )}
    </>
  );
}
