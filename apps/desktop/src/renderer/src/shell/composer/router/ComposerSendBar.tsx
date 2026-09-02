// The composer's input and its one primary action.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer has Send
// resolve "to the one wire call the addressed target admits", and everything visible
// here is that resolution made legible: the placeholder names the target, the label
// under the line names the path the send will take, and the refusal that comes back
// sits beside the control that produced it rather than replacing it.
//
// ONE PRIMARY ACTION. Send is the primary; Stop is a quiet control that appears only
// while the addressed target is a running turn, because a stop with nothing to stop
// is a control offered against nothing. Neither derives eligibility: Stop is offered
// on the ADDRESS and refuses through the daemon, which is the fail-closed direction.
//
// The component renders and does nothing else — the state, the router, and the
// history walk are `send-controller.ts`'s, so what is left here is markup, keyboard
// wiring, and the two absences this surface can honestly show.

import { useCallback, useId } from "react";

import { InlineRefusal, RefusalCard } from "../../../console/primitives/index.js";
import { type ComposerSeatProps } from "../../../console/workspace/index.js";
import { COMPOSER_DIRECTIVE_LINE_MAX_ROWS } from "../composer-bounds.js";
import { useComposerAddress } from "../composer-address.js";
import { readTextNeutralization } from "../neutralization-tripwire.js";
import { useSendController } from "./send-controller.js";

export function ComposerSendBar(props: ComposerSeatProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  const controller = useSendController(props.bridge, address.target);
  const pathLabelId = useId();
  const isSending = controller.status === "sending";
  const isProviderBound = address.target.path === "provider-bound";

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const line = event.currentTarget;
      const caret = {
        selectionStart: line.selectionStart,
        selectionEnd: line.selectionEnd,
        textLength: line.value.length,
      };
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void controller.send();
        return;
      }
      // The arrows recall only at the edge offsets, and only when there is something
      // to recall — otherwise they stay the caret's, which is what they are for
      // everywhere else in the input.
      if (event.key === "ArrowUp" && controller.recallOlder(caret)) {
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowDown" && controller.recallNewer(caret)) {
        event.preventDefault();
      }
    },
    [controller],
  );

  const neutralization = readTextNeutralization(
    isProviderBound ? address.target.providerFailureDetail : undefined,
  );

  return (
    <div className="meridian-composer__send">
      <textarea
        className="meridian-composer__line"
        aria-label="Message"
        aria-describedby={controller.pathLabel === undefined ? undefined : pathLabelId}
        placeholder={controller.placeholder}
        value={controller.text}
        rows={1}
        // The cap `Spec-023 §Console Design (Meridian)` asks for: the line grows to
        // it and then scrolls inside its own box, so the ledger above keeps its room.
        style={{ maxHeight: `calc(${String(COMPOSER_DIRECTIVE_LINE_MAX_ROWS)} * 1.5em)` }}
        readOnly={isSending}
        onChange={(event) => {
          controller.changeText(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="meridian-composer__send-row">
        {controller.pathLabel === undefined ? (
          <span className="meridian-composer__path" />
        ) : (
          <span className="meridian-composer__path" id={pathLabelId}>
            {controller.pathLabel}
          </span>
        )}
        {isProviderBound ? (
          <button
            type="button"
            className="meridian-composer__stop"
            onClick={() => {
              void controller.stop();
            }}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="meridian-composer__primary"
          aria-busy={isSending}
          disabled={isSending}
          onClick={() => {
            void controller.send();
          }}
        >
          {isSending ? "Sending" : "Send"}
        </button>
      </div>
      {controller.refusal === undefined ? null : (
        <InlineRefusal code={controller.refusal.code} detail={controller.refusal.detail} />
      )}
      {neutralization === undefined ? null : (
        <RefusalCard
          code={neutralization.code}
          detail={neutralization.wireDetail}
          action={<ResendOffer body={controller.resendableText} onResend={controller.resend} />}
        />
      )}
    </div>
  );
}

/**
 * The tripwire card's one offer.
 *
 * A component rather than a conditional inside the card, so the body it resends is
 * captured once and cannot go stale between the render that showed the button and
 * the click that pressed it. No body to resend means no offer — never a button that
 * sends an empty message.
 */
function ResendOffer(props: {
  readonly body: string | undefined;
  readonly onResend: (body: string) => Promise<void>;
}): React.JSX.Element | null {
  const { body, onResend } = props;
  if (body === undefined) {
    return null;
  }
  return (
    <button
      type="button"
      className="meridian-composer__resend"
      onClick={() => {
        void onResend(body);
      }}
    >
      Send again
    </button>
  );
}
