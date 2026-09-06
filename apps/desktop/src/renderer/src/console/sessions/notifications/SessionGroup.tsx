import type { AttentionItem } from "../../bridge/index.js";
import { WireFigure, formatCount } from "../../primitives/index.js";
import { type AttentionSessionGroup } from "./attention-plane.js";
import { AttentionItemList } from "./AttentionItemList.js";

/**
 * One session's items, actionable above informational.
 *
 * The informational half folds under a count while ANY session has actionable
 * attention — the design's density rule — and the fold is a `<details>` rather
 * than a control this component tracks state for: the platform element is
 * keyboard-reachable, announces its own expanded state, and costs no render pass
 * to open.
 */
export function SessionGroup(props: {
  readonly group: AttentionSessionGroup;
  readonly foldInformational: boolean;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { group } = props;
  const informational = <AttentionItemList items={group.informational} onOpen={props.onOpen} />;
  return (
    <section className="meridian-attention__group" aria-label={`Attention in ${group.sessionId}`}>
      <h3 className="meridian-attention__group-title">
        <WireFigure value={group.sessionId} />
      </h3>
      <AttentionItemList items={group.actionable} onOpen={props.onOpen} />
      {group.informational.length === 0 || !props.foldInformational ? (
        informational
      ) : (
        <details className="meridian-attention__fold">
          <summary className="meridian-attention__fold-summary">
            {`${formatCount(group.informational.length)} informational`}
          </summary>
          {informational}
        </details>
      )}
    </section>
  );
}
