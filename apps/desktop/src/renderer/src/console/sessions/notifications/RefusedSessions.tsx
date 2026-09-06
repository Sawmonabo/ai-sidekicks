import { InlineRefusal, WireFigure } from "../../primitives/index.js";
import { type RefusedAttentionSession } from "./attention-projection-read.js";
import { uncheckedSessionsSentence } from "./attention-sentences.js";

/**
 * The sessions this read never covered, each with the words the port refused in.
 *
 * A row per session rather than one refusal standing for all of them: the codes are
 * identical today because one operation raises them all, and a fan-out that later
 * refuses two sessions for two reasons would otherwise show one and hide the other.
 * The identifiers are wire figures, so a person can see WHICH sessions are missing
 * from the answer above rather than only how many.
 */
export function RefusedSessions(props: {
  readonly sessions: readonly RefusedAttentionSession[];
}): React.JSX.Element {
  return (
    <section
      className="meridian-attention__refused"
      aria-label="Sessions that could not be checked"
    >
      <p className="meridian-attention__refused-count">
        {uncheckedSessionsSentence(props.sessions.length)}
      </p>
      <ul className="meridian-attention__refused-list">
        {props.sessions.map((session) => (
          <li key={session.sessionId} className="meridian-attention__refused-row">
            <WireFigure value={session.sessionId} />
            <InlineRefusal code={session.refusal.code} detail={session.refusal.detail} />
          </li>
        ))}
      </ul>
    </section>
  );
}
