// The notifications list: what needs a person, then what finished or failed. It offers no dismiss
// (an entry clears when the daemon sets `resolvedAt`, and opening one resolves nothing) and
// re-filters nothing. It performs no read: it is handed the reading, so it and the sessions list
// use one projection.

import type { AttentionItem } from "@ai-sidekicks/contracts";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { NotificationsListBody } from "./NotificationsListBody.js";

import "./notifications.css";

/** What the notifications list draws from: the attention reading, the time, and how to open. */
export interface NotificationsListProps {
  /** The projection read's result; the destination performs it and the session list shares it. */
  readonly reading: AttentionReading;
  /** The instant each entry's age is measured from, in epoch milliseconds. */
  readonly nowMilliseconds: number;
  /** Opens the source of one entry. Renderer-local navigation; resolves nothing. */
  readonly onOpen?: (item: AttentionItem) => void;
}

/** The notifications list: its heading over the `Waiting on you` and `Earlier` groups. */
export function NotificationsList(props: NotificationsListProps): React.JSX.Element {
  return (
    <section className="meridian-attention" aria-label="Notifications">
      <header className="meridian-attention__head">
        <h2 className="meridian-attention__title">Notifications</h2>
      </header>
      <NotificationsListBody
        reading={props.reading}
        nowMilliseconds={props.nowMilliseconds}
        onOpen={props.onOpen}
      />
    </section>
  );
}
