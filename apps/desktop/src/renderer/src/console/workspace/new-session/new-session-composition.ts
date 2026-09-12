// What one draft's composition IS, apart from what it looks like.
//
// SPLIT FROM `NewSessionControl.tsx`, which renders. That file owns the markup, the
// labels, and which control is drawn in which state; this one owns the draft's
// lifetime, the per-draft send report, the settlement, and the two guards behind Send
// — and together they were one file past the package's ceiling. The seam is the one the
// component already had: it reads a composition and renders it, and every rule below
// can be checked without rendering anything at all.
//
// THE DRAFT IS THE SOURCE OF TRUTH and this hook subscribes to it rather than keeping
// selections of its own: two copies of what a person has chosen is how a discard
// clears one of them. `NewSessionControl.tsx`'s header carries the rest — why a
// settlement belongs to the draft that asked for it, why a draft belongs to the bridge
// it would send through, and why only the completed arm hands a session out.

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { useAnnounce } from "../../primitives/index.js";
import type { NewSessionControlProps } from "../../seats/index.js";
import {
  useSubjectScopedResource,
  useSubjectScopedState,
  type SubjectScopedDisposal,
} from "../../store/index.js";
import { NewSessionDraft, type NewSessionDraftState } from "./new-session-draft.js";
import { refuseSendThatRejected, type NewSessionSendResult } from "./new-session-settlement.js";

/**
 * What a person hears once a send settles. One sentence per outcome.
 *
 * A `Record` over the closed union rather than a lookup with a fallback, which is what
 * makes a fifth arm a compile error here instead of a silent empty announcement.
 */
const SEND_ANNOUNCEMENTS: Readonly<Record<NewSessionSendResult["outcome"], string>> = {
  sent: "The session was created.",
  partial: "The session was created, but not everything the draft asked for could be sent.",
  refused: "Nothing was sent, and the draft is still here.",
  "created-unreadable":
    "A session may have been created, and this window could not read the reply. Check the sessions list.",
};

/**
 * What a completed send says when the composition it closed is not the one on screen.
 *
 * NOT A FIFTH OUTCOME. Nothing about the send is different — every call it named landed
 * — so widening the vocabulary would put a wire settlement's name on a fact about this
 * window's timing. What differs is which composition the settlement is measured
 * against, which is this module's question and not the draft's.
 *
 * One string, said and rendered: the announcer speaks it and the control draws it, so
 * somebody who hears it and somebody who reads it are told the same thing.
 */
const SESSION_CREATED_WITH_UNSENT_EDITS =
  "The session was created. What you typed after pressing Send was not sent, and it is still here.";

/** Everything the control renders and every act it offers, in one hook. */
export interface NewSessionComposition {
  /** `undefined` while no draft is open — the state the "+ New" button is in. */
  readonly draftState: NewSessionDraftState | undefined;
  readonly sendResult: NewSessionSendResult | undefined;
  /**
   * True while THIS draft's send is running — what disables Send meanwhile.
   *
   * Scoped to the draft on screen rather than to the control: an older draft's send
   * settling says nothing about whether the composition a person is looking at may
   * be sent again.
   */
  readonly isSending: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly setFirstTurn: (firstTurn: string) => void;
  readonly send: () => void;
  /** The destination's directory re-read, offered where a send cannot be repeated. */
  readonly recheckDirectory: () => void;
  /**
   * True once a create answered with a reply this build could not read.
   *
   * Derived here rather than compared at each render site, because two things read it
   * — Send's disabled state and the act offered in its place — and a second spelling is
   * how one of them stops agreeing with the other.
   */
  readonly isAmbiguousCreate: boolean;
  /**
   * Present once a completed send settled over a composition that had moved on.
   *
   * The sentence rather than a flag, for the reason the refusal beside it is one: three
   * things read this state — the announcer, the line under the field, and Send's own
   * closed reason — and a boolean would have each of them composing its own words for it.
   *
   * Send is closed while it stands, and that is not politeness. Every leg this draft
   * names has landed, so a second press puts nothing on the wire and answers `sent`
   * again — this time over a composition that matches, which would close the draft and
   * discard the very words this state exists to keep.
   */
  readonly unsentEditsSentence: string | undefined;
}

/** What one draft's send is doing, and what it settled on. Held per draft. */
interface DraftSendReport {
  readonly isSending: boolean;
  readonly result: NewSessionSendResult | undefined;
}

/** A draft nobody has sent. One value, so every seed is the same object. */
const NO_SEND_YET: DraftSendReport = { isSending: false, result: undefined };

/**
 * No draft until "+ New" is pressed — the seed for a bridge nobody has composed on.
 *
 * The holder seeds during the render that first sees a subject, and a seed that
 * CONSTRUCTED a draft would make arriving at the sessions destination compose a
 * session. The act is the person's; this is what the control shows until they make it.
 */
function noDraftUntilOpened(): NewSessionDraft | undefined {
  return undefined;
}

/**
 * How a draft this control lets go of ends.
 *
 * Total over the seed, because a bridge that was never composed on holds no draft.
 * The discard is the draft's own — "a draft that is closed empty reverts to nothing
 * and leaves no row" is a claim about what `discard()` does, so dropping the object
 * without it would make closing mean something else.
 *
 * THE RELEASING ARM: `discard()` clears the selections and leaves a working draft, so
 * there is no closed state for the holder to recognise and a reading beside it would
 * claim a lifetime that does not end. Declared at module scope because the hook holds
 * the disposal on a dependency of its own.
 */
const DRAFT_DISPOSAL: SubjectScopedDisposal<NewSessionDraft | undefined> = {
  release: (draft) => {
    draft?.discard();
  },
};

/**
 * Hold the draft, and keep the rendered state in step with it.
 *
 * The draft is the source of truth and this hook subscribes to it rather than keeping
 * selections of its own: two copies of what a person has chosen is how a discard
 * clears one of them.
 */
export function useNewSessionComposition(props: NewSessionControlProps): NewSessionComposition {
  const { bridge, onSessionCreated } = props;
  const heldDraft = useSubjectScopedResource<NewSessionDraft | undefined>(
    bridge,
    undefined,
    noDraftUntilOpened,
    DRAFT_DISPOSAL,
  );
  const openDraft = heldDraft.value;
  const publishDraft = heldDraft.publish;
  // Addressed by the DRAFT, so a settlement is measured against the composition it
  // was sent for and not against a counter this component keeps. Where none is open
  // the bridge stands in as the subject: nothing is sending, and the seed says so.
  const sendReport = useSubjectScopedState<DraftSendReport>(
    openDraft ?? bridge,
    undefined,
    () => NO_SEND_YET,
  );
  const publishReport = sendReport.publish;
  const { isSending, result } = sendReport.value;
  const announce = useAnnounce();

  // Read off the draft rather than mirrored into state on every act: the draft emits
  // on each commit, and a second copy is one more thing a discard has to clear.
  const draftState = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        openDraft === undefined ? () => undefined : openDraft.subscribe(onChange),
      [openDraft],
    ),
    useCallback(() => openDraft?.snapshot(), [openDraft]),
  );

  const open = useCallback(() => {
    publishDraft(new NewSessionDraft({ bridge }));
  }, [bridge, publishDraft]);

  const close = useCallback(() => {
    // Published rather than discarded here: the holder disposes what it replaced,
    // through the same `discard()` a reconnect would run, so closing by hand and
    // closing by reconnect end a draft the same way.
    publishDraft(undefined);
  }, [publishDraft]);

  // Straight through to the draft, with nothing kept here: the field renders off the
  // draft's own `firstTurn`, so a discard clears the words on screen because it
  // cleared the only copy of them.
  const setFirstTurn = useCallback(
    (firstTurn: string) => {
      openDraft?.setFirstTurn(firstTurn);
    },
    [openDraft],
  );

  // The block as the DESTINATION reads it now, not as this render saw it.
  //
  // Held on a commit-time ref for `onSessionCreated`'s reason: the destination composes
  // the reading fresh on every pass, so naming it in a dependency array would rebuild
  // `send` on every render of the surface above. The reader inside it is stable and
  // asks two live sources, so a callback captured several renders ago still answers for
  // the shell as it stands when the press lands.
  const committedBlockedActRef = useRef(props.blockedAct);
  useLayoutEffect(() => {
    committedBlockedActRef.current = props.blockedAct;
  });

  const send = useCallback(() => {
    if (openDraft === undefined) {
      return;
    }
    // FAIL-CLOSED AT THE DISPATCH SITE, not only on the control. Send is disabled from
    // the same reading, so a press cannot ordinarily arrive here — but the block can
    // land in the frame between the render that enabled the button and the click that
    // reaches this handler, and what must not happen then is a `session.create`.
    // Nothing is published: the cause is already on screen beside the control, and a
    // sending flag set here would leave a spinner nothing settles.
    // `onboarding/provider-readiness/provider-readiness.ts`' `recheck` is the precedent.
    if (committedBlockedActRef.current.readSentence() !== undefined) {
      return;
    }
    // The publisher captured on THIS render is the one bound to the draft that is
    // sending. If the composition on screen has moved on by the time the create
    // settles, everything below installs nowhere — the result, the announcement it
    // would have caused, and the flag that would have re-enabled Send under a draft
    // still waiting on its own reply.
    publishReport({ isSending: true, result: undefined });
    void openDraft.send().then(
      (sendResult) => {
        publishReport({ isSending: false, result: sendResult });
      },
      () => {
        // A send that rejected outright USED to publish `NO_SEND_YET`, which cleared
        // the result: no banner, no announcement, no diagnostic, and a Send button
        // that answered a press by doing nothing. The draft names the fault in its own
        // vocabulary instead, so the refusal renders in the slot every other outcome
        // uses and the announce effect below says it out loud.
        //
        // A STRUCTURAL GUARD, and no test drives it, because nothing in this build
        // reaches it: `callDaemon` answers a rejected call, an absent door and an
        // unreadable reply alike with a typed refusal, and every statement `send()`
        // makes outside that call is total — so no wire a test can compose makes this
        // promise reject, and a test that did would need an injected draft this
        // component deliberately does not take. What the arm PUBLISHES is asserted
        // where it is built, in `new-session-draft.test.ts`.
        //
        // `then`'s SECOND ARGUMENT rather than a `.catch` tail, for that same reason
        // rather than a different one: a tail would also catch a throw from the arm
        // above it and report a fault of this component's as the draft's send
        // rejecting — the one fault this arm's sentence would be wrong about.
        publishReport({ isSending: false, result: refuseSendThatRejected() });
      },
    );
  }, [openDraft, publishReport]);

  // The destination's directory re-read, straight through. Not memoised and not held:
  // it is read from a press rather than from a dependency array, and the composition
  // this hook returns is rebuilt on every render regardless.
  const { onSessionDirectoryRecheck } = props;
  const recheckDirectory = useCallback(() => {
    onSessionDirectoryRecheck();
  }, [onSessionDirectoryRecheck]);

  // The settlement callback as it stood at the last COMMIT, so the effect below can
  // read it without depending on its identity.
  //
  // The destination composes it from the stores its context carries and hands over a
  // fresh function on every pass — the shape `SessionsSurface.tsx` states outright,
  // because nothing over there needs a stable one. Named in the effect's dependencies
  // it would re-run the whole settlement on every render of the surface above: the
  // sentence said twice, the session opened twice, the navigation put twice. Written
  // from a layout effect rather than the render body for `ledger/pane/feed`'s reason —
  // a pass React discards still runs a render body, and a callback captured there
  // belongs to a tree that never reached the screen.
  const committedSessionCreatedRef = useRef(onSessionCreated);
  useLayoutEffect(() => {
    committedSessionCreatedRef.current = onSessionCreated;
  });

  // The commit-time read, named once and stable forever, so the settlement effect below
  // calls a function rather than reaching into a ref. Reading `.current` inside an
  // effect that also announces is the shape a reader takes for a second copy of the
  // announce-once latch, and this composition holds no such latch —
  // the sentence is said once because a settlement lands once, not because a ref
  // remembers what was said. Naming the read here keeps that true where it is read.
  const settleCreatedSession = useCallback((createdSessionId: string) => {
    committedSessionCreatedRef.current(createdSessionId);
  }, []);

  // Said once, when a settlement LANDS, rather than from inside the continuation: a
  // result that installed nowhere is one nobody was waiting for, and announcing from
  // the value that reached the screen is what keeps those two facts the same one.
  //
  // AND THE COMPLETED SEND IS SETTLED FROM HERE, in that order, for the same reason
  // and one more. The reason: a result that reached the screen is a result whose draft
  // is still the one on screen, so the session handed out is the session this
  // composition asked for. The one more: settling navigates, so the sentence has to be
  // spoken first — said afterwards it would be addressed to a destination that is
  // already unmounting.
  //
  // The draft is dropped in the same act. It has done everything it can do — one draft
  // object mints at most one session, and every leg it names has landed — so leaving it
  // held would offer Send under a composition that can only re-report a session that
  // already exists, on a holder that outlives the navigation away from here.
  //
  // UNLESS THE COMPOSITION MOVED WHILE THE SEND RAN, which is the one case where
  // dropping it destroys something. `#performSend` captured the first message when it
  // read the draft, so words typed after the press were never sent — and `undefined`
  // published over the draft would take the only copy of them with it. The revisions
  // are compared instead: a settlement closes the composition it CARRIED and no other.
  //
  // A stale settlement keeps the draft AND stays here. Settling navigates, and the
  // sentence below is the whole report of what happened — spoken to a destination
  // already coming down, and drawn on a screen already leaving, it is a report nobody
  // receives. This is the same rule the partial arm already takes at this site: the
  // act is over, what it did is on screen, and the person decides what happens to the
  // words in front of them.
  const hasUnsentLaterEdits =
    result?.outcome === "sent" &&
    result.sentRevision !== undefined &&
    draftState !== undefined &&
    draftState.revision !== result.sentRevision;

  useEffect(() => {
    if (result === undefined) {
      return;
    }
    announce(
      hasUnsentLaterEdits ? SESSION_CREATED_WITH_UNSENT_EDITS : SEND_ANNOUNCEMENTS[result.outcome],
    );
    if (result.outcome !== "sent" || result.sessionId === undefined || hasUnsentLaterEdits) {
      return;
    }
    const createdSessionId = result.sessionId;
    publishDraft(undefined);
    settleCreatedSession(createdSessionId);
    // `hasUnsentLaterEdits` is a correct dependency and not a per-keystroke one: it is
    // false until a settlement lands and stays true once one has landed over a moved-on
    // draft, so a further edit re-renders without re-running this.
  }, [announce, hasUnsentLaterEdits, publishDraft, result, settleCreatedSession]);

  return {
    draftState,
    sendResult: result,
    isSending,
    open,
    close,
    setFirstTurn,
    send,
    recheckDirectory,
    isAmbiguousCreate: result?.outcome === "created-unreadable",
    unsentEditsSentence: hasUnsentLaterEdits ? SESSION_CREATED_WITH_UNSENT_EDITS : undefined,
  };
}
