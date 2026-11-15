// Walks back through what was sent from this session and writes it into the line. The composer
// mounts once per session, with the session screen, so it holds the one session's history.

import { useCallback, useState } from "react";

import type { DraftStore } from "#renderer/store/drafts.js";
import { SentMessageHistory } from "../sent-message-history.js";
import { caretAtEnd, caretAtStart, type DraftCaret } from "../caret.js";

/** The walk, and the record the dispatcher writes a sent body into. */
export interface SentMessageRecall {
  /** This session's own record. The dispatcher calls `recordSent` on a settled send. */
  readonly history: SentMessageHistory;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DraftCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DraftCaret): boolean;
}

/**
 * The recall pair for one session's composer. `readDraftText` is passed in so the walk and the
 * line agree on the current text.
 */
export function useSentMessageRecall(
  draftStore: DraftStore,
  draftKey: string,
  readDraftText: () => string,
): SentMessageRecall {
  // `useState` with an initializer constructs once; `useRef(new ...)` would build and discard
  // one per render.
  const [history] = useState(() => new SentMessageHistory());

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
