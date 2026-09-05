// "+ New": the control that makes a new-session draft reachable.
//
// `NewSessionDraft` shipped with a co-located test and no consumer — no control
// anywhere constructed one, so none of the draft selection, discard, or first-send
// behaviour it holds could be reached by a person. This is that consumer, on the
// sessions destination, which is where the corpus puts starting a session.
//
// WHY IT IS A SECOND CONTROL BESIDE "START A SESSION" AND NOT A REPLACEMENT. They
// are two acts. "Start a session" mounts the shipped Tier-1 probe, which creates one
// immediately with nothing chosen. A DRAFT is a session a person composes before it
// exists — no daemon row until the first send, and closing it empty leaves nothing
// behind. Replacing the probe would delete a path that works today; hiding the draft
// behind it would leave the composed path unreachable, which is the defect.
//
// WHAT IT OFFERS, AND WHY THAT AND NOT MORE. The posture axis, because it is a
// closed set the console already holds and the draft already takes. Agents and repo
// mounts are not offered: both need reads this surface would have to invent, and
// `Spec-023 §Console Design (Meridian)` rule 8 puts an unasked question in the
// _not checked_ absence rather than in a picker with nothing behind it. The draft's
// own send says the same thing about the wire — one of its three calls is
// registered, so a send lands `session.create` and refuses the other two by name.
//
// SEND IS DISABLED WHILE A SEND IS RUNNING, AND THAT IS THE SECOND GUARD. The draft
// coalesces repeated sends itself, so pressing twice cannot mint two sessions
// whatever this control does; disabling the button is what stops a person pressing
// into a control that looks like it did nothing. Structural guard first, affordance
// second — never the affordance alone, which is a guard that a keyboard path or a
// later caller does not get.
//
// AND A SETTLEMENT BELONGS TO THE DRAFT THAT ASKED FOR IT. Discard is reachable
// while a send is in flight, and "+ New" is reachable the moment it is — so a send
// can settle over a composition that is not the one it was sent for. The result, the
// announcement and the sending flag are therefore held per DRAFT, through
// `store/subject-scoped-state.ts`: a publisher captured when Send was pressed names
// the draft that pressed it, and installs nothing once the composition on screen is
// another one. Two sends in flight is the case that has to be per-draft: one boolean
// over two drafts re-enables Send under a composition that is still waiting.
//
// AND THE DRAFT ITSELF BELONGS TO THE BRIDGE IT WOULD SEND THROUGH. A draft holds
// the bridge it was composed against and sends `session.create` through that one, so
// a bridge REPLACEMENT — a reconnect, a second window's own instance, the fixture's
// scenario switch — leaves a draft addressed to a transport that is gone. The draft
// is held through `store/subject-scoped-resource.ts` on the bridge, so a replacement
// discards it and the control offers "+ New" again on the live one. That loses a
// composition, and it is the honest half of the trade: the alternative is a Send that
// looks ordinary and either never lands or lands somewhere the console will not read
// again, and a `sessionId` reported back for a session nobody can open.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { SIDEKICK_POSTURE_MODES, type ConsoleBridge } from "../bridge/index.js";
import { InlineRefusal, useAnnounce } from "../primitives/index.js";
import { useSubjectScopedResource, useSubjectScopedState } from "../store/index.js";
import {
  NewSessionDraft,
  type DraftPostureMode,
  type NewSessionDraftState,
  type NewSessionSendResult,
} from "./new-session-draft.js";

/** How each posture reads on a control, in the vocabulary's own order. */
const POSTURE_LABELS: Readonly<Record<DraftPostureMode, string>> = {
  trusted: "Trusted",
  "workspace-sandboxed": "Sandboxed to the workspace",
  "readonly-sandboxed": "Sandboxed, read-only",
};

/** What a person hears once a send settles. One sentence per outcome. */
const SEND_ANNOUNCEMENTS: Readonly<Record<NewSessionSendResult["outcome"], string>> = {
  sent: "The session was created.",
  partial: "The session was created, but not everything the draft asked for could be sent.",
  refused: "Nothing was sent, and the draft is still here.",
};

export interface NewSessionControlProps {
  readonly bridge: ConsoleBridge;
}

export function NewSessionControl(props: NewSessionControlProps): React.JSX.Element {
  const composition = useNewSessionComposition(props.bridge);

  if (composition.draftState === undefined) {
    return (
      <button type="button" className="meridian-new-session__open" onClick={composition.open}>
        + New
      </button>
    );
  }

  return (
    <section className="meridian-new-session" aria-label="New session draft">
      <fieldset className="meridian-new-session__postures">
        <legend>How its agents may work</legend>
        {SIDEKICK_POSTURE_MODES.map((mode) => (
          <label key={mode} className="meridian-new-session__posture">
            <input
              type="radio"
              name="meridian-new-session-posture"
              value={mode}
              checked={composition.draftState?.posture === mode}
              onChange={() => {
                composition.setPosture(mode);
              }}
            />
            {POSTURE_LABELS[mode]}
          </label>
        ))}
      </fieldset>
      {composition.sendResult?.refusal === undefined ? null : (
        <InlineRefusal
          code={composition.sendResult.refusal.code}
          detail={composition.sendResult.refusal.detail}
        />
      )}
      <div className="meridian-new-session__actions">
        <button type="button" className="meridian-new-session__discard" onClick={composition.close}>
          Discard
        </button>
        <button
          type="button"
          className="meridian-new-session__send"
          disabled={composition.draftState.isEmpty || composition.isSending}
          onClick={composition.send}
        >
          Send
        </button>
      </div>
    </section>
  );
}

/** Everything the control renders and every act it offers, in one hook. */
interface NewSessionComposition {
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
  readonly setPosture: (posture: DraftPostureMode) => void;
  readonly send: () => void;
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
 */
function discardDraft(draft: NewSessionDraft | undefined): void {
  draft?.discard();
}

/**
 * Hold the draft, and keep the rendered state in step with it.
 *
 * The draft is the source of truth and this hook subscribes to it rather than keeping
 * selections of its own: two copies of what a person has chosen is how a discard
 * clears one of them.
 */
function useNewSessionComposition(bridge: ConsoleBridge): NewSessionComposition {
  const heldDraft = useSubjectScopedResource<NewSessionDraft | undefined>(
    bridge,
    undefined,
    noDraftUntilOpened,
    discardDraft,
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
    // through the same `discard()` a bridge replacement would run, so closing by hand
    // and closing by reconnect end a draft the same way.
    publishDraft(undefined);
  }, [publishDraft]);

  const setPosture = useCallback(
    (posture: DraftPostureMode) => {
      openDraft?.setPosture(posture);
    },
    [openDraft],
  );

  const send = useCallback(() => {
    if (openDraft === undefined) {
      return;
    }
    // The publisher captured on THIS render is the one bound to the draft that is
    // sending. If the composition on screen has moved on by the time the create
    // settles, everything below installs nowhere — the result, the announcement it
    // would have caused, and the flag that would have re-enabled Send under a draft
    // still waiting on its own reply.
    publishReport({ isSending: true, result: undefined });
    void openDraft
      .send()
      .then((sendResult) => {
        publishReport({ isSending: false, result: sendResult });
      })
      .catch(() => {
        // A send that rejected outright reported nothing to render, so the draft goes
        // back to pressable rather than staying frozen behind its own guard.
        publishReport(NO_SEND_YET);
      });
  }, [openDraft, publishReport]);

  // Said once, when a settlement LANDS, rather than from inside the continuation: a
  // result that installed nowhere is one nobody was waiting for, and announcing from
  // the value that reached the screen is what keeps those two facts the same one.
  useEffect(() => {
    if (result !== undefined) {
      announce(SEND_ANNOUNCEMENTS[result.outcome]);
    }
  }, [announce, result]);

  return { draftState, sendResult: result, isSending, open, close, setPosture, send };
}
