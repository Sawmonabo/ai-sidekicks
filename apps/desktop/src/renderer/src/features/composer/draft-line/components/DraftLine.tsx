// The composer's message line: the draft field, and what needs only the draft. The text is the
// draft store's: this line reads the addressed key and writes every edit back, so a remount or
// re-address finds the text where it was left. Enter is swallowed here (no newline, no send);
// sending is `SendButton.tsx`'s.

import { useCallback, useEffect, useRef } from "react";
import { RefusalCard } from "#renderer/components/Refusal/RefusalCard.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";
import { subscribeToComposerFocus } from "../../focus-requests.js";
import { type ComposerProps } from "#renderer/registries/composer/registry.js";
import { COMPOSER_DRAFT_MAX_ROWS } from "../../bounds.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { readTextNeutralization } from "../text-neutralization.js";
import { useComposerDraftText } from "../../hooks/useComposerDraftText.js";
import { DRAFT_PLACEHOLDER } from "../caret.js";
import { composerDraftKey } from "../draft-key.js";

/** What the message line is handed: the composer's props and, for a measuring caller, its box. */
export interface DraftLineProps extends ComposerProps {
  /** The box the draft scrolls in, for the composer that measures what surrounds it. */
  readonly scrollerRef?: React.RefObject<HTMLDivElement | null>;
}

/** The message line over the addressed draft. Enter keeps the draft and sends nothing. */
export function DraftLine(props: DraftLineProps): React.JSX.Element {
  const { draftStore } = props;
  const target = useComposerAddress(props.sessionStore, props.focusedPane);
  const draftKey = composerDraftKey(target);
  const { text } = useComposerDraftText(draftStore, draftKey);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      draftStore.write(draftKey, event.currentTarget.value);
    },
    [draftStore, draftKey],
  );
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
    }
  }, []);

  const neutralization = readTextNeutralization(
    target.path === "provider-bound" ? target.providerFailureDetail : undefined,
  );

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
        placeholder={DRAFT_PLACEHOLDER}
        value={text}
        rows={1}
        // Grow to the cap, then scroll inside the box so the transcript keeps its room.
        maxRows={COMPOSER_DRAFT_MAX_ROWS}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {neutralization === undefined ? null : (
        <RefusalCard code={neutralization.code} detail={neutralization.wireDetail} />
      )}
    </div>
  );
}
