import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { Clock } from "#renderer/lib/clock.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import { ATTENTION_SUBJECT, type AttentionReading } from "#renderer/store/attention/summary.js";
import { NotificationEntryList } from "./NotificationEntryList.js";

/**
 * The list body: a `Waiting on you` group with its count over an `Earlier` group, newest first in
 * each. A group with no entries is not drawn, and with no entries at all nothing is drawn. While
 * the read is out it draws its loading line, and a failed read its line with `Try again`.
 */
export function NotificationsListBody(props: {
  readonly reading: AttentionReading;
  readonly clock: Clock;
  readonly nowMilliseconds: number;
  readonly onOpen: ((place: AppRoute) => void) | undefined;
}): React.JSX.Element | null {
  const { reading } = props;
  if (reading.phase === "reading") {
    return <LoadingNotice clock={props.clock} placement="block" title="Loading…" />;
  }
  if (reading.phase === "failed") {
    return (
      <InlineRefusal
        code={reading.refusal.code}
        detail={`Couldn't load ${ATTENTION_SUBJECT}`}
        onTryAgain={reading.readAgain}
      />
    );
  }
  const newestFirst = [...reading.summary.liveItems].reverse();
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
