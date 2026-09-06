import type { AttentionItem } from "../../bridge/index.js";
import { AttentionRow } from "./AttentionRow.js";

/** Zero or more items as one list. Zero renders nothing, never an empty list. */
export function AttentionItemList(props: {
  readonly items: readonly AttentionItem[];
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element | null {
  if (props.items.length === 0) {
    return null;
  }
  return (
    <ul className="meridian-attention__items">
      {props.items.map((item) => (
        <li key={item.id}>
          <AttentionRow item={item} onOpen={props.onOpen} />
        </li>
      ))}
    </ul>
  );
}
