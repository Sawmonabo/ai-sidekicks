// The one time a window tells somebody their unsent text survived a restart.
//
// Split from `send-controller.ts` because it is the controller's only concern that
// is not about an act: nothing here sends, settles, or refuses, and the whole of it
// is deciding WHEN a sentence the store already wrote has something to be about.
//
// THREE FACTS, AND ALL THREE HAVE TO HOLD. The store still owes the disclosure; this
// composer has been focused, which is what arms it; and there is text in the line for
// it to be about. A notice on an empty composer would be the window announcing a
// draft nobody can see, and a notice before focus would be it announcing one nobody
// has looked at.
//
// THE SENTENCE IS THE STORE'S OWN. Fixed text carrying no participant content, read
// rather than composed here — a second wording would be the same disclosure said two
// ways by two composers in one window.
//
// AND IT IS SAID ONCE PER WINDOW, NOT ONCE PER COMPOSER. `acknowledgeRestartNotice`
// is the store's, so the first composer to take focus consumes the debt and every
// other composer in the window finds it already paid.

import { useCallback, useState } from "react";

import type { DraftStore } from "../../../console/persistence/index.js";

/** The disclosure, and the acknowledgement that arms it. */
export interface RestartDisclosure {
  /** The store's sentence, while it is armed and there is text to lose. */
  readonly notice: string | undefined;
  /** Called when the line takes focus, which is what arms the disclosure. */
  acknowledge(): void;
}

/** The disclosure for one composer, measured against the text currently in its line. */
export function useRestartDisclosure(draftStore: DraftStore, text: string): RestartDisclosure {
  const [isArmed, setArmed] = useState(false);

  const acknowledge = useCallback(() => {
    if (!draftStore.restartNoticePending) {
      // Already told, in this composer or in another one this window holds. A second
      // arming would be the window saying it twice.
      return;
    }
    draftStore.acknowledgeRestartNotice();
    setArmed(true);
  }, [draftStore]);

  return {
    notice: isArmed && text.length > 0 ? draftStore.restartNoticeText : undefined,
    acknowledge,
  };
}
