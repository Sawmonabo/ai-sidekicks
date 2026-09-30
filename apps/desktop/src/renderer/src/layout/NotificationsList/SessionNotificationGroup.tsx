import type { AttentionItem } from "@ai-sidekicks/contracts";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { type AttentionSessionGroup } from "@renderer/store/attention/attention-summary.js";
import { NotificationEntryList } from "./NotificationEntryList.js";

/**
 * One session's items, actionable above informational. The informational half folds under a count
 * while any session has actionable attention, in a native `<details>` that is keyboard-reachable
 * and announces its own state.
 */
export function SessionNotificationGroup(props: {
  readonly group: AttentionSessionGroup;
  readonly foldInformational: boolean;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { group } = props;
  const informational = <NotificationEntryList items={group.informational} onOpen={props.onOpen} />;
  return (
    <section className="meridian-attention__group" aria-label={`Attention in ${group.sessionId}`}>
      <h3 className="meridian-attention__group-title">
        <WireFigure value={group.sessionId} />
      </h3>
      <NotificationEntryList items={group.actionable} onOpen={props.onOpen} />
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
