// The composer's typing producer, bound to the line a person is actually typing in.
//
// `Plan-023 §Phase 6 — Renderer Shell, Router, And Composer` T-023r-6-2 pins it at
// `shell/MessageComposer.tsx` — this plan's shell subtree and never a feature view's
// tree — and this is that leg's renderer half: the host calls one hook, and the hook
// owns the publisher's lifetime and drives it. The publication itself is
// `console/bridge/presence/composing-publisher.ts`, which states the three rules that
// matter — never Awareness directly (I-023-8), never for a membership-restricted
// channel (CP-023-4), and SILENT ON A REFUSAL — and holds the bounds. Nothing about
// any of the three lives here.
//
// The third is why this hook renders nothing and reports nothing. `activity.typing` is
// an ephemeral Awareness field: `Spec-002 §State And Data Implications` mints no
// durable event for it and `§Default Behavior` gives it no receipt, so there is no
// answer a refusal could contradict and nothing on screen it could correct. The
// publisher therefore retires itself on the first refused or thrown publication and
// says nothing — see that module's own `A REFUSAL IS TERMINAL FOR THE PUBLISHER'S
// LIFETIME` header note and its `#dispatch` — which is also why a person composing
// mid-sentence is never told about a wire that has not been built yet.
//
// THE LINE IS OBSERVED, NEVER COPIED. The draft store already holds the composer's
// unsent body under this address's key, and `use-composer-draft-text.ts` is the one
// reading of it that both other zones take. Watching that key is what makes this a
// third READER of one value rather than a second source of truth for what a person
// has typed — the failure `MessageComposer.tsx`'s own header names.
//
// A KEYSTROKE IS A CHANGE, NOT A VALUE. The first observation publishes nothing: a
// composer that mounted onto a restored draft would otherwise announce that its owner
// was typing every time a pane was re-opened, which is a claim about a person who is
// not there. What publishes is the line MOVING, and a line that moves to empty — a
// send landing, a person clearing what they wrote — stops rather than publishes.

import { useEffect, useRef } from "react";

import { ComposingPublisher, type ConsoleBridge } from "../../console/bridge/index.js";
import { consoleClockFor } from "../../console/bridge/index.js";
import type { ComposerSeatProps } from "../../console/seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../console/store/index.js";
import { useComposerAddress } from "./composer-address.js";
import { useComposerDraftText } from "./use-composer-draft-text.js";
import { composerDraftKey } from "./router/draft-key.js";

/**
 * The TERMINAL arm, because releasing a publisher ends it.
 *
 * `dispose()` clears an outstanding publication and then refuses every later call,
 * so there is a closed state and the holder is told how to recognise one. At module
 * level so the hook's dependency lists compare stable identities across renders.
 */
const publisherDisposal: SubjectScopedDisposal<ComposingPublisher> = {
  dispose: (publisher: ComposingPublisher): void => {
    publisher.dispose();
  },
  isClosed: (publisher: ComposingPublisher): boolean => publisher.isDisposed,
};

/**
 * Publish this participant's composing indicator for as long as they are typing.
 *
 * Renders nothing and returns nothing: the indicator this produces is read by
 * everybody else's console, and the sender's own screen shows it nowhere — which is
 * what an Awareness field is and why a publisher that answered anything back would be
 * modelling a receipt the wire does not carry.
 */
export function useComposingPublication(props: ComposerSeatProps): void {
  const { bridge, sessionStore, draftStore, focusedPane } = props;
  const { target } = useComposerAddress(sessionStore, focusedPane);
  const { text } = useComposerDraftText(draftStore, composerDraftKey(target));
  // The BRIDGE is the subject and the session is the key, which is the opposite of
  // the command enumeration's choice beside it and is opposite for a reason: this
  // publisher holds a growth port belonging to one binding, so a replaced bridge has
  // to mint a new publisher rather than go on publishing through a retired wire.
  const { value: publisher } = useSubjectScopedResource<ComposingPublisher>(
    bridge,
    sessionStore.sessionId,
    () => openPublisher(bridge, sessionStore.sessionId),
    publisherDisposal,
  );
  // Read apart so the effect depends on the two strings the gate reads rather than on
  // a target object whose identity moves whenever any partition it was derived from
  // does. A provider-bound target supplies neither, which is the fail-closed arm: a
  // steer is addressed to one agent's run and is nobody else's room to watch.
  const channelId = target.path === "channel-message" ? target.channelId : undefined;
  const channelName = target.path === "channel-message" ? target.channelLabel : undefined;
  const observedTextRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const observed = observedTextRef.current;
    observedTextRef.current = text;
    if (observed === undefined || observed === text) {
      return;
    }
    if (text === "") {
      publisher.stop();
      return;
    }
    publisher.noteComposing({ channelId, channelName });
  }, [publisher, text, channelId, channelName]);
}

/** Declared rather than inlined, so the resource holder is handed one shape. */
function openPublisher(bridge: ConsoleBridge, sessionId: string): ComposingPublisher {
  return new ComposingPublisher({
    growth: bridge.growth,
    clock: consoleClockFor(bridge),
    sessionId,
  });
}
