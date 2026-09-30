import type { AttentionItem } from "@ai-sidekicks/contracts";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { uncheckedSessionsSentence } from "./attention-sentences.js";
import { ReadCompleteness } from "./ReadCompleteness.js";
import { SessionNotificationGroup } from "./SessionNotificationGroup.js";

/** The list body: the reading state, the completeness notice, and one group per session. */
export function NotificationsListBody(props: {
  readonly reading: AttentionReading;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element | null {
  if (props.reading.phase === "reading") {
    return <Nothing kind="not-loaded" placement="block" title="Reading what needs you." />;
  }
  const { summary, droppedCount, refusedSessions } = props.reading;
  if (summary.groups.length === 0) {
    // Why nothing survived decides what is drawn. A read every session answered with an empty
    // projection draws nothing. A read some session never answered, or one whose every member the
    // boundary rejected, must not look like that, or a person is told they are free on an
    // unanswered question.
    if (refusedSessions.length > 0) {
      return (
        <>
          <Nothing
            kind="not-checked"
            placement="block"
            title="Some sessions could not be checked."
            detail={`${uncheckedSessionsSentence(refusedSessions.length)} Nothing was found in the ones that answered, which is not an all-clear.`}
          />
          <ReadCompleteness reading={props.reading} />
        </>
      );
    }
    if (droppedCount === 0) {
      return null;
    }
    return (
      <>
        <Nothing
          kind="not-checked"
          placement="block"
          title="Nothing in that read could be recognized."
        />
        <ReadCompleteness reading={props.reading} />
      </>
    );
  }
  return (
    <>
      <ReadCompleteness reading={props.reading} />
      <ul className="meridian-attention__groups">
        {summary.groups.map((group) => (
          <li key={group.sessionId}>
            <SessionNotificationGroup
              group={group}
              foldInformational={summary.hasActionable}
              onOpen={props.onOpen}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
