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
// Stop's own disabled state says nothing about eligibility either — it says an
// interrupt this bar issued is still in flight, which is this surface's own fact.
//
// THE DISABLED BUTTON COVERS THE POINTER PATH AND ONLY THAT PATH. A read-only
// textarea still receives key events, so an Enter repeat or a second press before
// settlement reaches this handler with nothing in the DOM to stop it. The keyboard
// gate below is the render-state half of the guard; the half that holds inside one
// frame is the controller's synchronous latch, because this handler reads the status
// from the render that produced it.
//
// The component renders and does nothing else — the state, the router, and the
// history walk are `send-controller.ts`'s, so what is left here is markup, keyboard
// wiring, and the two absences this surface can honestly show.
//
// THE LINE'S TEXT IS THE DRAFT STORE'S. The seat is handed a window-lifetime store
// and this bar neither owns the body nor copies it; the one thing it owns about the
// draft is WHEN the store's restart disclosure is taken on, which the store documents
// as the first focus of a composer.

import { useCallback, useEffect, useId, useRef } from "react";
import { RefusalCard, RemediedRefusal } from "../../../console/primitives/index.js";
import { subscribeToComposerFocus, type ComposerSeatProps } from "../../../console/seats/index.js";
import { COMPOSER_DIRECTIVE_LINE_MAX_ROWS } from "../composer-bounds.js";
import { useComposerAddress } from "../composer-address.js";
import { readTextNeutralization } from "../neutralization-tripwire.js";
import { useComposerCommandZone } from "../commands/client-command-executor.js";
import { composerDraftKey } from "./draft-key.js";
import type { ProviderCommandEnumeration } from "../commands/provider-command-holder.js";
import { useSendController } from "./send-controller.js";
import { ResendOffer } from "./ResendOffer.js";

export type ComposerSendBarProps = ComposerSeatProps & {
  /**
   * The composer's one enumeration reading, opened by the discovery surface.
   *
   * Read and never opened here: a typed name that the bound provider published is
   * refused by name rather than sent, and the reading that answers is the same one
   * the popover is showing — not a second read of the same wire.
   */
  readonly commandEnumeration: ProviderCommandEnumeration;
};

export function ComposerSendBar(props: ComposerSendBarProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // BOTH HALVES OR NEITHER. The router will not intercept a name its recogniser does
  // not claim, and an intercepted name with no executor refuses rather than running,
  // so the two are supplied together by the zone that owns both.
  const commandZone = useComposerCommandZone({
    route: props.route,
    commandEnumeration: props.commandEnumeration,
    // The same address the send path acts on, so the name this zone recognises as
    // published comes from the addressed run's own binding and not from a sibling
    // binding the same agent happens to hold.
    target: address.target,
    // The accelerators' own inputs. The zone reaches no wire of its own for the
    // recogniser or the enumeration; these are for the one command that starts work.
    growth: props.bridge.growth,
    sessionId: props.sessionStore.sessionId,
    draftStore: props.draftStore,
    draftKey: composerDraftKey(address.target),
  });
  const controller = useSendController({
    bridge: props.bridge,
    target: address.target,
    draftStore: props.draftStore,
    recognizeClientCommand: commandZone.recognizeClientCommand,
    commandExecutor: commandZone.commandExecutor,
    recognizeProviderCommand: commandZone.recognizeProviderCommand,
  });
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
        // Always swallowed, sending or not: a read-only textarea still receives key
        // events, so letting the default through while a send is in flight would put
        // a newline into a line the person believes is locked.
        event.preventDefault();
        if (isSending) {
          return;
        }
        void controller.send();
        return;
      }
      if (isSending) {
        // Everything past this point WRITES the line. A read-only textarea still
        // receives key events, so an unguarded recall would swap the text under a
        // person who cannot type into it — and it would advance the walk's cursor
        // besides, so the draft they left is not the draft they come back to once
        // the send settles. Nothing is swallowed here: the arrows stay the caret's,
        // which is movement a read-only line still permits.
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
    [controller, isSending],
  );

  const neutralization = readTextNeutralization(
    isProviderBound ? address.target.providerFailureDetail : undefined,
  );

  // The seat's other direction. A surface elsewhere in the window — the runs pane's
  // empty state is the first — tells a person to send a message; this is what makes
  // that sentence actionable from where they are standing. The ask carries nothing,
  // so what focusing means stays this component's decision, and an ask that arrives
  // while no composer is mounted reaches nobody rather than queueing.
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
        // The store arms its restart disclosure at construction and consumes it the
        // first time a composer is focused, so focus is where this composer takes it
        // on. The sentence itself waits for the line to hold unsent text, which is
        // what it is about — an untouched composer says nothing about text nobody
        // has typed.
        onFocus={() => {
          controller.acknowledgeRestartNotice();
        }}
        onKeyDown={onKeyDown}
      />
      {controller.restartNotice === undefined ? null : (
        <p className="meridian-composer__notice">{controller.restartNotice}</p>
      )}
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
            // The rendered half of Stop's own single-flight guard: the interrupt is
            // not idempotent, so a second press must not issue a second one. The
            // half that holds inside one frame is the controller's synchronous ref,
            // because this handler reads the status from the render that made it.
            aria-busy={controller.isStopping}
            disabled={controller.isStopping}
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
        // Through the remedy join rather than straight to the inline shape: the
        // send router reaches `intervention.idempotency_conflict`,
        // `run.version_conflict`, and `session.not_found`, and each of those has a
        // next move the daemon's own sentence does not carry.
        <RemediedRefusal refusal={controller.refusal} />
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
