// The composer's message line: the draft field, and what needs only the draft. The text is the
// draft store's: this line reads the session's draft key and writes every edit back, so a remount
// or a return to the session finds the text where it was left. Enter is swallowed here (no
// newline, no send); sending is `SendButton.tsx`'s.

import { useCallback, useEffect, useRef } from "react";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";
import { subscribeToComposerFocus } from "../../focus-requests.js";
import { type ComposerProps } from "#renderer/registries/composer/registry.js";
import { COMPOSER_DRAFT_MAX_ROWS } from "../../bounds.js";
import { useComposerDraftText } from "../../hooks/useComposerDraftText.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectSessionShape } from "#renderer/store/session/selectors.js";
import { DRAFT_PLACEHOLDERS } from "../caret.js";
import { composerDraftKey } from "../draft-key.js";

/** What the message line is handed: the composer's props and, for a measuring caller, its box. */
export interface DraftLineProps extends ComposerProps {
  /** The box the draft scrolls in, for the composer that measures what surrounds it. */
  readonly scrollerRef?: React.RefObject<HTMLDivElement | null>;
}

/** The message line over the session's draft. Enter keeps the draft and sends nothing. */
export function DraftLine(props: DraftLineProps): React.JSX.Element {
  const { draftStore } = props;
  const draftKey = composerDraftKey(props.sessionStore.sessionId);
  const { text } = useComposerDraftText(draftStore, draftKey);
  // The empty line's words follow the session's shape; until the session's read says it, the line
  // says nothing rather than guess.
  const shape = useSessionStore(props.sessionStore, selectSessionShape);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      draftStore.write(draftKey, event.currentTarget.value);
    },
    [draftStore, draftKey],
  );
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // A message on its way: its text and the reply's are parsed soon, so the parser starts now.
    markdownWorker.wake();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
    }
  }, []);

  // Lets a view elsewhere in the window ask for the caret. The ask carries nothing, and one
  // arriving while no composer is mounted reaches nobody.
  const lineRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(
    () =>
      subscribeToComposerFocus(() => {
        lineRef.current?.focus();
      }),
    [],
  );

  return (
    <div className="meridian-composer__send">
      <TextBox
        fieldRef={lineRef}
        {...(props.scrollerRef === undefined ? {} : { scrollerRef: props.scrollerRef })}
        className="meridian-composer__line"
        aria-label="Message"
        {...(shape === undefined ? {} : { placeholder: DRAFT_PLACEHOLDERS[shape] })}
        value={text}
        rows={1}
        // Grow to the cap, then scroll inside the box so the transcript keeps its room.
        maxRows={COMPOSER_DRAFT_MAX_ROWS}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
