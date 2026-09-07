// The auto-pin switch, and what it will actually do.
//
// One switch, default on, persisted through `session-preferences.ts` — and beneath it
// the two sentences that say what the rule decides, composed FROM the rule rather
// than written beside it. `autoPinDecision` is the one home of the five conjuncts, so
// a switch whose explanatory text was hand-written would be a second statement of
// them and would go wrong the first time a conjunct moved.
//
// TWO ORIGINS ARE RENDERED BECAUSE TWO ARE REACHABLE. A session started from the
// control next door is one this window authored: it is a draft placeholder, it did
// not arrive by an import, it was not opened for child work, and no workflow started
// it — four markers this console holds rather than guesses. Every OTHER session
// reaches the list through a directory read that carries no origin at all, and the
// rule's fail-closed arm answers `origin-unreported` for it. Saying only the first
// would promise a person that everything gets pinned; saying neither would leave a
// switch whose effect is a mystery.
//
// THE REFUSAL IS THE STORE'S. A switch that could not be written is a durable write
// that failed, and it renders as itself rather than as a control that silently
// snapped back.

import { InlineRefusal } from "../../primitives/index.js";
import {
  autoPinDecision,
  type AutoPinDecision,
  type SessionOriginEvidence,
} from "../rows/auto-pin.js";
import type { SessionPreferenceBinding } from "../rows/session-preferences.js";

/**
 * A session this window started: every marker known, none of them an exclusion.
 *
 * Stated once here rather than at each reader, because it is the ONE origin the
 * console can report in full — it authored the session — and a second spelling of it
 * would be a second claim about what a start press produces.
 */
const STARTED_IN_THIS_WINDOW: SessionOriginEvidence = {
  isDraftPlaceholder: true,
  arrivedByImport: false,
  openedForChildWork: false,
  startedByWorkflow: false,
};

/** A session the console did not author: the directory read carries no origin marker. */
const ORIGIN_NOT_REPORTED: SessionOriginEvidence = {};

export interface AutoPinSettingProps {
  readonly preferences: SessionPreferenceBinding;
}

export function AutoPinSetting(props: AutoPinSettingProps): React.JSX.Element {
  const { preferences } = props;
  const isEnabled = preferences.isAutoPinOnFirstSendEnabled;
  return (
    <div className="meridian-auto-pin">
      <label className="meridian-auto-pin__switch">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => {
            preferences.setAutoPinOnFirstSend(event.target.checked);
          }}
        />
        <span className="meridian-auto-pin__label">
          Pin a session the first time I send into it
        </span>
      </label>
      <p className="meridian-auto-pin__consequence">
        {describeDecision(
          autoPinDecision({ isSettingEnabled: isEnabled, origin: STARTED_IN_THIS_WINDOW }),
          "A session you start here",
        )}
      </p>
      <p className="meridian-auto-pin__consequence">
        {describeDecision(
          autoPinDecision({ isSettingEnabled: isEnabled, origin: ORIGIN_NOT_REPORTED }),
          "A session this window did not start",
        )}
      </p>
      {preferences.lastRefusal === undefined ? null : (
        <InlineRefusal {...preferences.lastRefusal} />
      )}
    </div>
  );
}

/**
 * The rule's answer, as a sentence.
 *
 * Total over the refusal vocabulary rather than defaulted, so a conjunct added to the
 * rule is a compile error here instead of a session silently described by the wrong
 * sentence — which is the whole reason the decision carries a reason at all.
 */
function describeDecision(decision: AutoPinDecision, subject: string): string {
  if (decision.pins) {
    return `${subject} is pinned to the front the first time you send into it.`;
  }
  switch (decision.because) {
    case "setting-off":
      return `${subject} is not pinned. Nothing is pinned automatically while this is off.`;
    case "not-a-draft-placeholder":
      return `${subject} is not pinned: it is past being a draft.`;
    case "arrived-by-import":
      return `${subject} is not pinned: it arrived by an import.`;
    case "opened-for-child-work":
      return `${subject} is not pinned: it was opened for another run's work.`;
    case "started-by-workflow":
      return `${subject} is not pinned: a workflow started it.`;
    case "origin-unreported":
      return `${subject} is not pinned: nothing reports where it came from, and this console will not guess. Pin it yourself from its row.`;
  }
}
