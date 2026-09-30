// The notification center: one place that answers "what needs me".
//
// Two rules of the notification center and the attention projection decide the shape of
// this file more than the layout does:
//
//   • **It offers no dismiss.** The contract has no dismiss method and no
//     client-writable resolution field, and emission is derived from canonical state
//     rather than from client heuristics — a dismiss-all control would be exactly
//     that heuristic. An item clears when the daemon sets `resolvedAt`; opening one
//     navigates and resolves nothing.
//   • **It re-filters nothing.** Which moments raise a banner is decided once, by the
//     daemon, when it writes the entry, so a second filter here would be a second
//     authority on a decision already made.
//
// THIS COMPONENT PERFORMS NO READ. It is handed the reading, because the
// all-sessions list beside it takes each row's severity off the same projection and two
// reads would eventually disagree about one question.
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { NotificationsListBody } from "./NotificationsListBody.js";

import "./notifications.css";

/** What the notifications list draws: the attention reading and how to open an item. */
export interface NotificationsListProps {
  /**
   * The projection read's result. The destination performs the read and hands it
   * here, so the center and the all-sessions list read one projection and cannot
   * disagree about what needs a person.
   */
  readonly reading: AttentionReading;
  /** Open the source of one item. Renderer-local navigation; resolves nothing. */
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
