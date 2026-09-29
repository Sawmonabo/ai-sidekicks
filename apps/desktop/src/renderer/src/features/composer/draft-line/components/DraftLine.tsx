// The composer's message line: the draft field, and what needs only the draft.
//
// THE LINE'S TEXT IS THE DRAFT STORE'S. The seat is handed a window-lifetime store and
// this line neither owns the body nor copies it: it reads the addressed key, writes
// every edit back, and re-reads on every write, so a remount or a re-address finds the
// text where it was left.
//
// ENTER SENDS NOTHING HERE. The line takes no calls, so it swallows Enter — the key
// neither reaches the daemon nor puts a newline into the line — and the draft stays as
// typed with nothing drawn. Sending is `SendButton.tsx`'s, which takes the two daemon
// calls a send makes as an argument.
//
// The component renders and does nothing else: a text field over the draft, the
// neutralization card the addressed run's failure detail asks for, and the focus ask a
// surface elsewhere in the window can make.

import { useCallback, useEffect, useRef } from "react";
import { RefusalCard } from "@renderer/console/primitives/index.js";
import { subscribeToComposerFocus, type ComposerProps } from "@renderer/console/seats/index.js";
import { COMPOSER_DRAFT_MAX_ROWS } from "../../composer-bounds.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { readTextNeutralization } from "../text-neutralization.js";
import { useComposerDraftText } from "../../hooks/useComposerDraftText.js";
import { composeDraftPlaceholder } from "../draft-line.js";
import { composerDraftKey } from "../draft-key.js";

/** The message line over the addressed draft. Enter keeps the draft and sends nothing. */
export function DraftLine(props: ComposerProps): React.JSX.Element {
  const { draftStore } = props;
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  const draftKey = composerDraftKey(address.target);
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
    address.target.path === "provider-bound" ? address.target.providerFailureDetail : undefined,
  );

  // The seat's other direction. A surface elsewhere in the window tells a person to send
  // a message; this is what makes that sentence actionable from where they are
  // standing. The ask carries nothing, so what focusing means stays this component's
  // decision, and an ask that arrives while no composer is mounted reaches nobody
  // rather than queueing.
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
      <textarea
        ref={lineRef}
        className="meridian-composer__line"
        aria-label="Message"
        placeholder={composeDraftPlaceholder()}
        value={text}
        rows={1}
        // The growth cap: the line grows to it and then scrolls inside its own box,
        // so the transcript above keeps its room.
        style={{ maxHeight: `calc(${String(COMPOSER_DRAFT_MAX_ROWS)} * 1.5em)` }}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {neutralization === undefined ? null : (
        <RefusalCard code={neutralization.code} detail={neutralization.wireDetail} />
      )}
    </div>
  );
}
