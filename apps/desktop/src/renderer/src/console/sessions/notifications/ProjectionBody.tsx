import type { AttentionItem } from "../../bridge/index.js";
import { Nothing, RefusalCard } from "../../primitives/index.js";
import { type AttentionReading } from "./attention-plane.js";
import { NOTHING_NEEDS_YOU, uncheckedSessionsSentence } from "./attention-sentences.js";
import { ReadCompleteness } from "./ReadCompleteness.js";
import { RefusedSessions } from "./RefusedSessions.js";
import { SessionGroup } from "./SessionGroup.js";

export function ProjectionBody(props: {
  readonly reading: AttentionReading;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
  /**
   * Re-open the projection read. Rendered on the refused phase and nowhere else.
   *
   * Optional for `onOpen`'s reason: this body is mounted in harnesses that hold no
   * read, and a control that cannot act is worse than none. The destination that owns
   * the read supplies it.
   */
  readonly onReopen: (() => void) | undefined;
}): React.JSX.Element {
  if (props.reading.phase === "reading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading what needs you." />;
  }
  if (props.reading.phase === "not-asked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The attention projection has not been read."
        detail="Nothing on the installed bridge reads it yet, so this console has not asked. It is not an all-clear — an all-clear is an answer, and no question was put."
      />
    );
  }
  if (props.reading.phase === "refused") {
    // The read was put and it failed, which is neither an all-clear nor a question
    // nobody asked. The refusal renders with its own code, verbatim.
    return (
      <RefusalCard
        code={props.reading.refusal.code}
        detail={props.reading.refusal.detail}
        action={
          props.onReopen === undefined ? undefined : (
            <button type="button" onClick={props.onReopen}>
              Try again
            </button>
          )
        }
      />
    );
  }
  const { plane, droppedCount, refusedSessions } = props.reading;
  if (plane.groups.length === 0) {
    // Nothing survived the boundary. WHY nothing survived decides which absence
    // this is, and there are now three reasons rather than two: a read that
    // answered for every session with an empty projection is an all-clear; a read
    // some session never answered is coverage this console does not have; and a
    // read every member of which the boundary rejected is the console failing to
    // recognise an answer it did receive. Reporting either of the last two as the
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
          <RefusedSessions sessions={refusedSessions} />
        </>
      );
    }
    return droppedCount === 0 ? (
      <Nothing
        kind="empty"
        placement="surface"
        title={NOTHING_NEEDS_YOU}
        detail="Approvals, questions, finished runs, invitations, and mentions all appear here while they are unresolved."
      />
    ) : (
      <>
        <Nothing
          kind="not-checked"
          placement="surface"
          title="Nothing in that read could be recognised."
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
            <SessionGroup
              group={group}
              foldInformational={plane.hasActionable}
              onOpen={props.onOpen}
            />
          </li>
        ))}
      </ul>
      {refusedSessions.length === 0 ? null : <RefusedSessions sessions={refusedSessions} />}
    </>
  );
}
