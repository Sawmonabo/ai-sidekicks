// One draft's composition, apart from how it looks. `NewSessionControl.tsx` owns the markup;
// this hook owns the draft's lifetime, the per-draft send report, the settlement and the
// guards behind Send. The draft is the source of truth and this hook subscribes to it rather
// than keeping selections of its own, so a discard cannot leave a second copy behind.

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { useAnnounce } from "@renderer/hooks/useAnnounce.js";
import type { NewSessionControlProps } from "../new-session-control-contract.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { NewSessionDraft, type NewSessionDraftState } from "../new-session-draft.js";
import { refuseSendThatRejected, type NewSessionSendResult } from "../new-session-settlement.js";

/**
 * What a person hears once a send settles, one sentence per outcome. A `Record` over the
 * closed union, so a new outcome is a compile error here instead of a silent announcement.
 */
const SEND_ANNOUNCEMENTS: Readonly<Record<NewSessionSendResult["outcome"], string>> = {
  sent: "The session was created.",
  partial: "The session was created, but not everything the draft asked for could be sent.",
  refused: "Nothing was sent, and the draft is still here.",
  "created-unreadable":
    "A session may have been created, and this window could not read the reply. Check the sessions list.",
};

/**
 * What a completed send says when the composition it closed is not the one on screen. Not a
 * fifth outcome: every call landed, and only this window's timing differs. One string, both
 * announced and drawn, so hearing it and reading it say the same thing.
 */
const SESSION_CREATED_WITH_UNSENT_EDITS =
  "The session was created. What you typed after pressing Send was not sent, and it is still here.";

/** Everything the control renders and every act it offers, in one hook. */
export interface NewSessionComposition {
  /** `undefined` while no draft is open — the state the "+ New" button is in. */
  readonly draftState: NewSessionDraftState | undefined;
  readonly sendResult: NewSessionSendResult | undefined;
  /**
   * True while this draft's send is running, which disables Send. Scoped to the draft on
   * screen: an older draft's send settling says nothing about the one a person is looking at.
   */
  readonly isSending: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly setFirstTurn: (firstTurn: string) => void;
  readonly send: () => void;
  /** The destination's directory re-read, offered where a send cannot be repeated. */
  readonly recheckDirectory: () => void;
  /**
   * True once a create answered with a reply this build could not read. Derived here because
   * Send's disabled state and the act offered in its place both read it.
   */
  readonly isAmbiguousCreate: boolean;
  /**
   * Present once a completed send settled over a composition that had moved on. A sentence,
   * so the announcer, the line under the field and Send's disabled reason share one wording.
   * Send is closed while it stands: every leg has landed, so a second press would answer
   * `sent` over a matching composition and close the draft, discarding the words this state
   * keeps.
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
 * No draft until "+ New" is pressed. The holder seeds during the render that first sees a
 * subject, so a seed that constructed a draft would compose a session on arrival.
 */
function noDraftUntilOpened(): NewSessionDraft | undefined {
  return undefined;
}

/**
 * How a draft this control lets go of ends. `discard()` clears the selections rather than
 * closing the draft, so the disposal is a release and not a closed-state reading. Declared at
 * module scope because the hook holds the disposal on a dependency of its own.
 */
const DRAFT_DISPOSAL: SubjectScopedDisposal<NewSessionDraft | undefined> = {
  release: (draft) => {
    draft?.discard();
  },
};

/** Hold the draft, and keep the rendered state in step with it. */
export function useNewSessionComposition(props: NewSessionControlProps): NewSessionComposition {
  const { bridge, queueFirstTurn, lead, onSessionCreated } = props;
  const heldDraft = useSubjectScopedResource<NewSessionDraft | undefined>(
    bridge,
    undefined,
    noDraftUntilOpened,
    DRAFT_DISPOSAL,
  );
  const openDraft = heldDraft.value;
  const publishDraft = heldDraft.publish;
  // Addressed by the draft, so a settlement is measured against the composition it was sent
  // for. With no draft open the bridge stands in as the subject; nothing is sending.
  const sendReport = useSubjectScopedState<DraftSendReport>(
    openDraft ?? bridge,
    undefined,
    () => NO_SEND_YET,
  );
  const publishReport = sendReport.publish;
  const { isSending, result } = sendReport.value;
  const announce = useAnnounce();

  // Read off the draft rather than mirrored into state, so a discard clears the only copy.
  const draftState = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        openDraft === undefined ? () => undefined : openDraft.subscribe(onChange),
      [openDraft],
    ),
    useCallback(() => openDraft?.snapshot(), [openDraft]),
  );

  const open = useCallback(() => {
    publishDraft(new NewSessionDraft({ bridge, queueFirstTurn, lead }));
  }, [bridge, queueFirstTurn, lead, publishDraft]);

  const close = useCallback(() => {
    // Published, not discarded here: the holder disposes what it replaced through the same
    // `discard()` a reconnect runs.
    publishDraft(undefined);
  }, [publishDraft]);

  // Straight through to the draft: the field renders off the draft's `firstTurn`.
  const setFirstTurn = useCallback(
    (firstTurn: string) => {
      openDraft?.setFirstTurn(firstTurn);
    },
    [openDraft],
  );

  const send = useCallback(() => {
    if (openDraft === undefined) {
      return;
    }
    // The publisher captured on this render is bound to the sending draft. If the composition
    // on screen moved on before the create settles, the result, the announcement and the
    // flag that would re-enable Send install nowhere.
    publishReport({ isSending: true, result: undefined });
    void openDraft.send().then(
      (sendResult) => {
        publishReport({ isSending: false, result: sendResult });
      },
      () => {
        // A rejection must not publish `NO_SEND_YET`, which would clear the result and leave a
        // Send that answers a press by doing nothing. The draft names the fault in its own
        // vocabulary so the announce effect says it out loud.
        //
        // No test drives this arm because nothing in this build reaches it: `callDaemon` and
        // the rest of `send()` are total. What it publishes is asserted where it is built, in
        // `new-session-draft.test.ts`. It is `then`'s second argument rather than a `.catch`
        // tail, which would also catch a throw from the arm above and misreport it as the
        // draft's.
        publishReport({ isSending: false, result: refuseSendThatRejected() });
      },
    );
  }, [openDraft, publishReport]);

  // The destination's directory re-read, straight through. Not memoized: it is read from a
  // press, and the returned composition is rebuilt every render anyway.
  const { onSessionDirectoryRecheck } = props;
  const recheckDirectory = useCallback(() => {
    onSessionDirectoryRecheck();
  }, [onSessionDirectoryRecheck]);

  // The settlement callback as of the last commit, so the effect below does not depend on its
  // identity. A destination may hand over a fresh function each pass; depending on it would
  // re-run the effect on every render and say a standing result's sentence again each time.
  // Written from a layout effect because a discarded render still runs the render body.
  const committedSessionCreatedRef = useRef(onSessionCreated);
  useLayoutEffect(() => {
    committedSessionCreatedRef.current = onSessionCreated;
  });

  // A stable named read, so the effect below calls a function instead of reaching into a ref
  // next to an announcement, which would look like a second announce-once latch.
  const settleCreatedSession = useCallback((createdSessionId: string) => {
    committedSessionCreatedRef.current(createdSessionId);
  }, []);

  // Said once when a settlement lands, from the value that reached the screen rather than
  // from inside the continuation, so a result that installed nowhere is never announced.
  //
  // A completed send is settled from here, after the sentence: settling navigates, so
  // speaking afterwards would address a destination already unmounting. The draft is dropped
  // in the same act, since every leg it names has landed and Send could only re-report the
  // session.
  //
  // Unless the composition moved while the send ran: the send captured the first message when
  // it read the draft, so publishing `undefined` would destroy the only copy of later words.
  // The revisions are compared, and a stale settlement keeps the draft and stays here, since
  // navigating would take its sentence away with it.
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
    // `hasUnsentLaterEdits` stays false until a settlement lands and true once it lands over
    // a moved-on draft, so a further edit re-renders without re-running this.
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
