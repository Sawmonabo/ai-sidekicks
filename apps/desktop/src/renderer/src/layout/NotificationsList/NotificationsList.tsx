// The notification center: one place that answers "what needs me". It offers no dismiss (the
// contract has none; an item clears when the daemon sets `resolvedAt`, and opening one resolves
// nothing) and re-filters nothing (the daemon decides once which moments raise a banner). It
// performs no read: it is handed the reading, so it and the all-sessions list use one projection.

import type { AttentionItem } from "@ai-sidekicks/contracts";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { NotificationsListBody } from "./NotificationsListBody.js";

import "./notifications.css";

/** What the notifications list draws: the attention reading and how to open an item. */
export interface NotificationsListProps {
  /** The projection read's result; the destination performs it and the session list shares it. */
  readonly reading: AttentionReading;
  /** Opens the source of one item. Renderer-local navigation; resolves nothing. */
  readonly onOpen?: (item: AttentionItem) => void;
}

/** The notifications list: what needs a person, grouped by session. */
export function NotificationsList(props: NotificationsListProps): React.JSX.Element {
  return (
    <section className="meridian-attention" aria-label="Attention">
      <header className="meridian-attention__head">
        <h2 className="meridian-attention__title">Needs you</h2>
      </header>
      <NotificationsListBody reading={props.reading} onOpen={props.onOpen} />
    </section>
  );
}
