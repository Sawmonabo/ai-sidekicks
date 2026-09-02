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

import { useCallback, useState } from "react";

import { SIDEKICK_POSTURE_MODES, type ConsoleBridge } from "../bridge/index.js";
import { InlineRefusal, useAnnounce } from "../primitives/index.js";
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
          disabled={composition.draftState.isEmpty}
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
  readonly open: () => void;
  readonly close: () => void;
  readonly setPosture: (posture: DraftPostureMode) => void;
  readonly send: () => void;
}

/**
 * Hold the draft, and keep the rendered state in step with it.
 *
 * The draft is the source of truth and this hook mirrors its snapshots rather than
 * keeping selections of its own: two copies of what a person has chosen is how a
 * discard clears one of them. Nothing is constructed until "+ New" is pressed, so
 * mounting the sessions destination composes no draft — the act is the person's.
 */
function useNewSessionComposition(bridge: ConsoleBridge): NewSessionComposition {
  const [draft, setDraft] = useState<NewSessionDraft | undefined>(undefined);
  const [draftState, setDraftState] = useState<NewSessionDraftState | undefined>(undefined);
  const [sendResult, setSendResult] = useState<NewSessionSendResult | undefined>(undefined);
  const announce = useAnnounce();

  const open = useCallback(() => {
    const opened = new NewSessionDraft({ bridge });
    // Subscribed rather than re-read after each act: the draft emits on every
    // commit, so one subscription keeps the render in step with every path that
    // mutates it, including ones this control does not call itself.
    opened.subscribe(setDraftState);
    setDraft(opened);
    setDraftState(opened.snapshot());
    setSendResult(undefined);
  }, [bridge]);

  const close = useCallback(() => {
    // `discard()` first and then the local drop, in that order: the draft's own
    // discard is what leaves no row behind, and dropping the object without it would
    // make "closed empty" mean something different from what §4.8 says it means.
    draft?.discard();
    setDraft(undefined);
    setDraftState(undefined);
    setSendResult(undefined);
  }, [draft]);

  const setPosture = useCallback(
    (posture: DraftPostureMode) => {
      draft?.setPosture(posture);
    },
    [draft],
  );

  const send = useCallback(() => {
    if (draft === undefined) {
      return;
    }
    void draft.send().then((result) => {
      setSendResult(result);
      // Once, on the settlement, and never on a re-render: the outcome is the thing a
      // person waited for, and the refusal below carries the detail.
      announce(SEND_ANNOUNCEMENTS[result.outcome]);
    });
  }, [announce, draft]);

  return { draftState, sendResult, open, close, setPosture, send };
}
