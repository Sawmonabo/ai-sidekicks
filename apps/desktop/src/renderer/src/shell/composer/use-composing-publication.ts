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
//
// AND A CHANGE IS A CHANGE OF LINE, NOT OF TEXT, WHICH IS WHY THE ADDRESS IS OBSERVED
// BESIDE IT. The composer is one control that re-addresses; the draft under it is a
// different line each time it does. Comparing the two texts alone made two drafts that
// happen to read the same word indistinguishable from one line nobody touched — so
// moving from a channel to another address left that channel's indicator lit until the
// receiver's idle bound expired it, and the address arrived at published nothing at
// all. The observation therefore carries the DRAFT KEY the text was read under, which
// is exactly the identity `use-composer-draft-text.ts` subscribes by, and a key that
// moved is a re-address whatever the two texts say: the line left behind is stopped and
// the line arrived at is noted. Nothing here holds a timer for that — the idle clear
// stays armed on the publisher, which is the one object that owns a timeout at all.

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
 * One reading of the composer's line, and the address it was read under.
 *
 * The pair rather than the text alone, because "did this change" is a question about
 * both: two addresses whose drafts read the same word are two different lines, and a
 * comparison that could not tell them apart is what left one channel's indicator up.
 */
interface ObservedComposerLine {
  /** The `DraftStore` key the text below was read under — this composer's address. */
  readonly draftKey: string;
  /** What that key held on the render this observation was taken from. */
  readonly text: string;
}

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
  const draftKey = composerDraftKey(target);
  const { text } = useComposerDraftText(draftStore, draftKey);
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
  const observedLineRef = useRef<ObservedComposerLine | undefined>(undefined);
  useEffect(() => {
    const observed = observedLineRef.current;
    observedLineRef.current = { draftKey, text };
    if (observed === undefined) {
      return;
    }
    const hasReAddressed = observed.draftKey !== draftKey;
    if (!hasReAddressed && observed.text === text) {
      return;
    }
    // A re-address stops the line being LEFT before the line arrived at is noted, and
    // an emptied line stops for the same reason a send does. Both take the publisher's
    // own idempotent clear, so an address that was never publishing costs no wire call
    // — `stop` returns early with nothing outstanding — and the two conditions
    // collapsing onto one statement is what keeps a move to an empty draft from
    // clearing twice.
    if (hasReAddressed || text === "") {
      publisher.stop();
    }
    if (text !== "") {
      publisher.noteComposing({ channelId, channelName });
    }
  }, [publisher, draftKey, text, channelId, channelName]);
}

/** Declared rather than inlined, so the resource holder is handed one shape. */
function openPublisher(bridge: ConsoleBridge, sessionId: string): ComposingPublisher {
  return new ComposingPublisher({
    growth: bridge.growth,
    clock: consoleClockFor(bridge),
    sessionId,
  });
}
