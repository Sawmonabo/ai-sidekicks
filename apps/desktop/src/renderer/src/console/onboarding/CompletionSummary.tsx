// What finishing means, stated plainly — including finishing with nothing set up.
//
// OFFERED, NEVER DEMANDED. Zero registered accounts is a legitimate terminal: a node
// whose operator skipped this is a fully onboarded node that cannot yet start a provider
// run. So this summary does not warn, does not block, and does not colour anything for
// attention. It names which providers are not ready and says exactly what the first run
// against one of them will do — refuse, with a typed refusal carrying the same remedy
// this step showed — because that is the consequence a person is accepting.
//
// AND IT NAMES THEM RATHER THAN COUNTING THEM. "Two providers are not ready" is a
// sentence a person cannot act on; the provider names are what they take away.
//
// WHAT IS DEMANDED IS GROUP A, AND THE ACT IS WITHDRAWN RATHER THAN GUARDED WHILE IT
// IS OUTSTANDING. The two halves of the walkthrough are not alike: group B may be
// finished over with nothing set up, and group A may not be finished AROUND — the
// relay choice sits behind a modal that stays shut until it is made, and telemetry
// takes an explicit answer with no silent default. This footer is on every step, so
// it was the one control that could dispatch `onboarding.complete` from a step nobody
// had answered, and a daemon that accepted it would record this node as set up over
// two questions never put. `standing` is the whole of that fact — one value decides
// both the disabled control and the missing handler, on the telemetry step's
// precedent — and it is composed in the step model, which is where the split lives.
//
// AND AN ACT THAT HAS HAPPENED IS NOT OFFERED AGAIN. The same value carries the other
// end: once the daemon's own read reports this node set up, the footer renders a
// terminal and no control. The summary above it stays, because what a person leaves
// with is which providers are not ready — that is the whole of the completion posture,
// and it is as true after finishing as it was before.

import { WireFigure } from "../primitives/index.js";
import { ZERO_ACCOUNTS_NOTE } from "./provider-readiness/provider-readiness-copy.js";
import {
  providersNotReady,
  type ProviderReadinessReading,
} from "./provider-readiness/provider-readiness-reading.js";
import type { OnboardingCompletionStanding } from "./steps/step-model.js";

export interface CompletionSummaryProps {
  readonly reading: ProviderReadinessReading;
  /**
   * Where the completion act stands, as one closed value.
   *
   * ON THE HELD ARM the control is taken away as well as explained: no handler is
   * wired at all, so nothing here reaches `onboarding.complete` however the press
   * arrives. The reason is rendered as text beside the control rather than as a
   * `title`, because a disabled control takes no focus and a tooltip is the one place
   * a keyboard reader will not find it.
   *
   * ON THE SETTLED ARM there is no control at all — this node is already recorded as
   * set up, and an act that has happened is not one to offer again. What stays on
   * screen is the provider standing, which is what a person has to leave the flow
   * knowing.
   */
  readonly standing: OnboardingCompletionStanding;
  readonly isFinishing: boolean;
  readonly onFinish: () => void;
}

export function CompletionSummary(props: CompletionSummaryProps): React.JSX.Element {
  const { standing } = props;
  return (
    <section className="meridian-onboarding__step" aria-label="Finish setting up">
      {renderProviderStanding(props.reading)}
      {standing.kind === "held" ? (
        <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
          {standing.reason}
        </p>
      ) : null}
      {standing.kind === "settled" ? (
        <p className="meridian-onboarding__note">
          This node is set up. Nothing here is outstanding — the standing above is what it is
          running with, and every part of it can be changed later from settings.
        </p>
      ) : (
        <button
          type="button"
          className="meridian-onboarding__act"
          onClick={standing.kind === "held" ? undefined : props.onFinish}
          disabled={standing.kind === "held" || props.isFinishing}
        >
          Finish setting up
        </button>
      )}
    </section>
  );
}

/**
 * Which providers are not ready, or why that cannot be said.
 *
 * A read that failed does NOT become "everything is ready": the summary says it could
 * not tell, which is the difference rule 8's kinds of nothing exist to keep.
 */
function renderProviderStanding(reading: ProviderReadinessReading): React.ReactNode {
  if (reading.kind !== "read") {
    return (
      <p className="meridian-onboarding__note">
        Which providers this node can run was not read, so this summary does not say. Finishing is
        still fine — the step is offered rather than required.
      </p>
    );
  }
  const notReady = providersNotReady(reading.entries);
  if (notReady.length === 0) {
    return (
      <p className="meridian-onboarding__note">
        Every provider this node selects is ready. A run can start against any of them.
      </p>
    );
  }
  return (
    <>
      <p className="meridian-onboarding__note">
        These providers are not ready:{" "}
        {notReady.map((providerName, position) => (
          <span key={providerName}>
            {position === 0 ? null : ", "}
            <WireFigure value={providerName} />
          </span>
        ))}
        .
      </p>
      <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
        {ZERO_ACCOUNTS_NOTE}
      </p>
    </>
  );
}
