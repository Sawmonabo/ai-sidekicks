// The one notice a surface renders when what it is showing is not the whole answer.
//
// The model beside it (`partial-read.ts`) owns the vocabulary and the sentence set;
// this owns the box they are carried in, which is three decisions and no copy:
//
//   • **Above the rows, never instead of them.** The rows on screen are still the best
//     reading there is; what the notice withdraws is the claim that they are all of
//     it. A notice that replaced the list would throw away a partial answer to avoid
//     overstating it, which is the worse of the two errors.
//   • **The consequence is the sentence; the cause is the refusal beneath it.** Rule 9
//     puts a refusal's code in mono and its message verbatim, so the cause renders
//     through `InlineRefusal` and this component paraphrases none of it.
//   • **The count is the console's own arithmetic**, so it wears the derived signature
//     rather than the wire one (rule 4). It is formatted by `wire-figures.ts` and by
//     nothing else — the model does the formatting, so a caller cannot reach a second
//     `toLocaleString` on the way here.
//
// ONE LIVE REGION OF ITS OWN, AND ONLY WHERE THIS COMPONENT WRITES THE PROSE. The
// `reading` arm delegates to `Nothing`, which carries its own `role="status"`;
// wrapping that in a second status region would announce one sentence twice. So the
// wrapper — and its role — exists on the prose arms alone. The nested `InlineRefusal`
// keeps the region rule 9's refusal grammar gives it: this notice may not take a
// refusal's region away, and it does not add a second one beside its own.

import { Nothing } from "./Nothing.js";
import { DerivedFigure } from "./Figure.js";
import { InlineRefusal } from "./Refusal.js";
import { partialReadNotice, type ReadingState } from "./partial-read.js";

export interface PartialReadProps {
  readonly state: ReadingState;
  /**
   * What was read, as a lowercase noun phrase: "the queue", "these quotas".
   *
   * Mid-sentence in every arm, so a caller never capitalizes it and two callers
   * cannot disagree about whether it is a sentence's head.
   */
  readonly subject: string;
}

/**
 * The reading's own account of how complete it is.
 *
 * Renders nothing for a served reading, and something for every other state — which
 * is the whole claim: a surface that mounts this can only ever say less than
 * complete, never more.
 */
export function PartialRead(props: PartialReadProps): React.JSX.Element | null {
  const notice = partialReadNotice(props.state, props.subject);
  if (notice.shape === "none") {
    return null;
  }
  if (notice.shape === "reading") {
    // Inline rather than a surface-shaped block: the read is in flight beside rows
    // that are already on screen, and a block would stand in for a surface that is
    // there.
    return <Nothing kind="not-loaded" placement="inline" title={notice.title} />;
  }
  return (
    <div className="meridian-partial-read" role="status">
      <p className="meridian-partial-read__copy">
        {notice.figure === undefined ? null : (
          <>
            <DerivedFigure text={notice.figure} />{" "}
          </>
        )}
        {notice.copy}
      </p>
      {notice.refusal === undefined ? null : (
        <InlineRefusal code={notice.refusal.code} detail={notice.refusal.detail} />
      )}
    </div>
  );
}
