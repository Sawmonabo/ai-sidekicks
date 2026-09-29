import type { AttentionItem } from "@renderer/console/bridge/wire-shapes/attention-projection.js";
import { Nothing } from "@renderer/console/primitives/index.js";
import { type AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { NOTHING_NEEDS_YOU, uncheckedSessionsSentence } from "./attention-sentences.js";
import { ReadCompleteness } from "./ReadCompleteness.js";
import { SessionNotificationGroup } from "./SessionNotificationGroup.js";

export function NotificationsListBody(props: {
  readonly reading: AttentionReading;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  if (props.reading.phase === "reading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading what needs you." />;
  }
  const { plane, droppedCount, refusedSessions } = props.reading;
  if (plane.groups.length === 0) {
    // Nothing survived the boundary. WHY nothing survived decides which absence
    // this is, and there are now three reasons rather than two: a read that
    // answered for every session with an empty projection is an all-clear; a read
    // some session never answered is coverage this console does not have; and a
    // read every member of which the boundary rejected is the console failing to
    // recognize an answer it did receive. Reporting either of the last two as the
    // first is the conflation the five kinds of nothing exist to prevent — it tells
    // a person they are free on the strength of a question that went unanswered.
    if (refusedSessions.length > 0) {
      return (
        <>
          <Nothing
            kind="not-checked"
            placement="surface"
            title="Some sessions could not be checked."
            detail={`${uncheckedSessionsSentence(refusedSessions.length)} Nothing was found in the ones that answered, which is not an all-clear.`}
          />
          <ReadCompleteness reading={props.reading} />
        </>
      );
    }
    return droppedCount === 0 ? (
      <Nothing
        kind="empty"
        placement="surface"
        title={NOTHING_NEEDS_YOU}
        detail="Approvals, questions, finished runs, and mentions all appear here while they are unresolved."
      />
    ) : (
      <>
        <Nothing
          kind="not-checked"
          placement="surface"
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
        {plane.groups.map((group) => (
          <li key={group.sessionId}>
            <SessionNotificationGroup
              group={group}
              foldInformational={plane.hasActionable}
              onOpen={props.onOpen}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
