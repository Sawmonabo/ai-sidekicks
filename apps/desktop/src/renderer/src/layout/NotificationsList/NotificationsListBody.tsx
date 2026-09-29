import type { AttentionItem } from "@ai-sidekicks/contracts";
import { Nothing } from "@renderer/console/primitives/index.js";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { uncheckedSessionsSentence } from "./attention-sentences.js";
import { ReadCompleteness } from "./ReadCompleteness.js";
import { SessionNotificationGroup } from "./SessionNotificationGroup.js";

export function NotificationsListBody(props: {
  readonly reading: AttentionReading;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element | null {
  if (props.reading.phase === "reading") {
    return <Nothing kind="not-loaded" placement="block" title="Reading what needs you." />;
  }
  const { summary, droppedCount, refusedSessions } = props.reading;
  if (summary.groups.length === 0) {
    // Nothing survived the boundary. WHY nothing survived decides what is drawn: a
    // read that answered for every session with an empty projection draws nothing
    // under the heading, because nothing waiting is shown by absence; a read some
    // session never answered is coverage this console does not have; and a read every
    // member of which the boundary rejected is the console failing to recognize an
    // answer it did receive. Drawing either of the last two as the first would tell a
    // person they are free on the strength of a question that went unanswered.
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
