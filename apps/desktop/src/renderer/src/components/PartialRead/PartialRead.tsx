// The notices a view renders when what it shows is not the whole answer. `partial-read.ts` owns
// the vocabulary and sentences, `ReadingNotice.tsx` the shape of one notice; this owns the box.
//
// - Above the rows, never instead of them: the rows are still the best reading there is.
// - Every reading the view holds, or none: the props take the set, so a tail cannot go unreported.
// - The consequence is the sentence and the cause is the refusal beneath it, rendered through
//   `InlineRefusal` and never paraphrased.
// - The count is the app's own arithmetic, so it wears the derived signature, formatted by
//   `lib/wire/figures.ts` only.
//
// Neither this component nor the notice creates a live region: the `reading` arm delegates to
// `Nothing` and a prose arm nests `InlineRefusal`, which own theirs, and a wrapper would announce
// the same sentence twice while mounting with its content already in it. To speak the sentence,
// a view calls `useAnnounceOncePerSentence`.

import { ReadingNotice } from "./ReadingNotice.js";
import { partialReadNotices, type ReadingState } from "#renderer/lib/partial-read.js";

/** Props for `PartialRead`. */
export interface PartialReadProps {
  /**
   * Every reading this view holds; a view is incomplete once per producer that could not finish.
   */
  readonly states: readonly ReadingState[];
  /** What was read, as a lowercase noun phrase ("the queue"); it sits mid-sentence in every arm. */
  readonly subject: string;
}

/** One notice per reading that did not serve, and nothing when all served. */
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
