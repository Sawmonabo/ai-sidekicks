// Walking back through what was sent from THIS address, and writing it back into the
// line.
//
// Split from `send-controller.ts` because it is a different job with a different
// lifetime: the controller dispatches acts and settles them, and this walks a record
// of acts already settled. Nothing here reaches the wire, nothing here can refuse,
// and the only state it owns is a cursor.
//
// THE CURSOR IS A REF AND NOT STATE. The walk's position is not rendered — what is
// rendered is the draft the walk wrote — so putting it in state would re-render the
// whole bar on a keystroke that changed nothing a person can see.
//
// THE HISTORIES ARE PER ADDRESS AND ASKED ON EVERY PASS. A message sent to a channel
// is not on the way back through an agent's composer, so each address keeps its own
// record; and the record is resolved in the render body rather than in an effect,
// because a keystroke arriving before an effect could run must still walk this
// address's history rather than the one before it. `forAddress` is idempotent for an
// address already current, which is what makes asking here safe.

import { useCallback, useRef } from "react";

import type { DraftStore } from "../../../console/persistence/index.js";
import {
  AddressedDirectiveHistories,
  caretAtEnd,
  caretAtStart,
  DirectiveHistory,
  type DirectiveCaret,
} from "./directive-line.js";

/** The walk, and the record the dispatcher writes a sent body into. */
export interface DirectiveRecall {
  /** This address's own record. The dispatcher calls `recordSent` on a settled send. */
  readonly history: DirectiveHistory;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DirectiveCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DirectiveCaret): boolean;
}

/**
 * The recall pair for one addressed composer.
 *
 * `readDraftText` is passed rather than read from the store here so the walk and the
 * line agree about what "the current text" is: the controller already holds a
 * value-stable reader for `useSyncExternalStore`, and a second read written here
 * would be a second answer to the same question.
 */
export function useDirectiveRecall(
  draftStore: DraftStore,
  draftKey: string,
  readDraftText: () => string,
): DirectiveRecall {
  const historiesRef = useRef<AddressedDirectiveHistories>(new AddressedDirectiveHistories());
  const history = historiesRef.current.forAddress(draftKey);

  const recallOlder = useCallback(
    (caret: DirectiveCaret) => {
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
    (caret: DirectiveCaret) => {
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
