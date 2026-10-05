// Walks back through what was sent from this address and writes it into the line. The cursor
// is a ref, not state, since it is never rendered and state would re-render the bar per key.
// Histories are per address and resolved in the render body, so a keystroke before an effect
// runs still walks this address's history; `forAddress` is idempotent, which makes that safe.

import { useCallback, useState } from "react";

import type { DraftStore } from "#renderer/store/draft-store.js";
import { SentMessageHistories, SentMessageHistory } from "../sent-message-history.js";
import { caretAtEnd, caretAtStart, type DraftCaret } from "../draft-line.js";

/** The walk, and the record the dispatcher writes a sent body into. */
export interface SentMessageRecall {
  /** This address's own record. The dispatcher calls `recordSent` on a settled send. */
  readonly history: SentMessageHistory;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DraftCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DraftCaret): boolean;
}

/**
 * The recall pair for one addressed composer. `readDraftText` is passed in so the walk and the
 * line agree on the current text.
 */
export function useSentMessageRecall(
  draftStore: DraftStore,
  draftKey: string,
  readDraftText: () => string,
): SentMessageRecall {
  // `useState` with an initializer constructs once; `useRef(new ...)` would build and discard
  // one per render.
  const [histories] = useState(() => new SentMessageHistories());
  const history = histories.forAddress(draftKey);

  const recallOlder = useCallback(
    (caret: DraftCaret) => {
      if (!caretAtStart(caret)) {
        return false;
      }
      const recalled = history.recallOlder(readDraftText());
      if (recalled === undefined) {
        return false;
      }
      draftStore.write(draftKey, recalled);
      return true;
    },
    [draftStore, draftKey, readDraftText, history],
  );

  const recallNewer = useCallback(
    (caret: DraftCaret) => {
      if (!caretAtEnd(caret)) {
        return false;
      }
      const recalled = history.recallNewer();
      if (recalled === undefined) {
        return false;
      }
      draftStore.write(draftKey, recalled);
      return true;
    },
    [draftStore, draftKey, history],
  );

  return { history, recallOlder, recallNewer };
}
