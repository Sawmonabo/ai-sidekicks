// The notifications list: what needs a person, then what finished or failed. It offers no dismiss
// (an entry clears when the daemon sets `resolvedAt`, and opening one resolves nothing) and
// re-filters nothing. It performs no read: it is handed the reading, so it and the sessions list
// use one projection.

import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { useAgesNow } from "#renderer/hooks/useAgesNow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type AttentionReading } from "#renderer/store/attention/summary.js";
import { NotificationsListBody } from "./NotificationsListBody.js";

import "./NotificationsList.css";

/** What the notifications list draws from: the attention reading and how to open an entry. */
export interface NotificationsListProps {
  /** The projection read's result; the destination performs it and the session list shares it. */
  readonly reading: AttentionReading;
  /** Opens the source of one entry. Renderer-local navigation; resolves nothing. */
  readonly onOpen?: (item: AttentionItem) => void;
}

/**
 * The notifications list: its heading over the `Waiting on you` and `Earlier` groups, every
 * entry's age advancing together on the list's one beat.
 */
export function NotificationsList(props: NotificationsListProps): React.JSX.Element {
  const { reading } = props;
  const nowMilliseconds = useAgesNow(
    useClock(),
    reading.phase === "read" ? reading.summary.liveItems.map((item) => item.createdAt) : [],
  );
  return (
    <section className="meridian-attention" aria-label="Notifications">
      <header className="meridian-attention__head">
        <h2 className="meridian-attention__title">Notifications</h2>
      </header>
      <NotificationsListBody
        reading={reading}
        nowMilliseconds={nowMilliseconds}
        onOpen={props.onOpen}
      />
    </section>
  );
}
