// The notices a surface renders when what it is showing is not the whole answer.
//
// The model beside it (`partial-read.ts`) owns the vocabulary and the sentence set,
// and `ReadingNotice.tsx` owns the shape one notice is rendered in; this owns the box
// they are carried in, which is four decisions and no copy:
//
//   • **Above the rows, never instead of them.** The rows on screen are still the best
//     reading there is; what a notice withdraws is the claim that they are all of
//     it. A notice that replaced the list would throw away a partial answer to avoid
//     overstating it, which is the worse of the two errors.
//   • **Every reading the surface holds, or none of them.** The props take the SET,
//     so a surface cannot mount a notice for its snapshot and quietly leave its tail
//     unreported. A single-reading caller passes one member; nothing renders when
//     every member is served.
//   • **The consequence is the sentence; the cause is the refusal beneath it.** Rule 9
//     puts a refusal's code in mono and its message verbatim, so the cause renders
//     through `InlineRefusal` and this component paraphrases none of it.
//   • **The count is the console's own arithmetic**, so it wears the derived signature
//     rather than the wire one (rule 4). It is formatted by `wire-figures.ts` and by
//     nothing else — the model does the formatting, so a caller cannot reach a second
//     `toLocaleString` on the way here.
//
// NEITHER THIS COMPONENT NOR THE NOTICE CREATES A LIVE REGION. `LiveAnnouncerProvider`
// states the console's standing absolute — one announcer per window, and no other
// component making a region — and the two regions a notice can touch are already
// spoken for: the `reading` arm delegates to `Nothing`, which carries its own, and a
// prose arm nests `InlineRefusal`, which carries rule 9's. A wrapper of its own would
// have been a second region announcing the same sentence, nested inside the refusal's,
// and mounting with its content already in it — the shape screen readers do not
// reliably announce at all. Where the SENTENCE itself has to be spoken, the surface
// calls `useReadingAnnouncement`, which routes it through the announcer's persistent,
// `aria-atomic` pair rather than through a region invented at the moment it spoke.

import { ReadingNotice } from "./ReadingNotice.js";
import { partialReadNotices, type ReadingState } from "./partial-read.js";

export interface PartialReadProps {
  /**
   * Every reading this surface holds about what it is showing.
   *
   * A set rather than one reading, because a surface is incomplete once for each
   * producer that could not finish: a snapshot that refused and a tail that carried
   * an unreadable delivery are two facts a person acts on differently.
   */
  readonly states: readonly ReadingState[];
  /**
   * What was read, as a lowercase noun phrase: "the queue", "these quotas".
   *
   * Mid-sentence in every arm, so a caller never capitalizes it and two callers
   * cannot disagree about whether it is a sentence's head.
   */
  readonly subject: string;
}

/**
 * The readings' own account of how complete they are.
 *
 * Renders nothing when every reading served, and something for every one that did
 * not — which is the whole claim: a surface that mounts this can only ever say less
 * than complete, never more.
 */
export function PartialRead(props: PartialReadProps): React.JSX.Element | null {
  const notices = partialReadNotices(props.states, props.subject);
  if (notices.length === 0) {
    return null;
  }
  return (
    <>
      {notices.map((notice, noticeOrdinal) => (
        <ReadingNotice key={`${notice.shape}-${String(noticeOrdinal)}`} notice={notice} />
      ))}
    </>
  );
}
