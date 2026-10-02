import type { AttentionItem } from "@ai-sidekicks/contracts";
import { NotificationEntry } from "./NotificationEntry.js";

/** One group's entries as one list. */
export function NotificationEntryList(props: {
  readonly items: readonly AttentionItem[];
  readonly nowMilliseconds: number;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  return (
    <ul className="meridian-attention__items">
      {props.items.map((item) => (
        <li key={item.id}>
          <NotificationEntry
            item={item}
            nowMilliseconds={props.nowMilliseconds}
            onOpen={props.onOpen}
          />
        </li>
      ))}
    </ul>
  );
}
