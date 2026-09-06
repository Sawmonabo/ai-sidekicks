// The stuck badge: the daemon's stall reading for one run, at the volume the quiet
// interval earns.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "A stuck badge from
// `health.stuckRunInspect`, appearing at the 60 second threshold and escalating in
// presentation at 5 minutes." Both thresholds are presentation and `stall-tier.ts`
// owns them; what decides whether a badge appears AT ALL is `healthSignal`, which is
// the daemon's.
//
// A HEALTHY RUN GETS A SENTENCE, NOT A BLANK. "The daemon inspected this run and found
// it moving" is an answer, and rendering nothing for it would leave a person unable to
// tell an inspection that came back clean from one that was never put — which is the
// distinction the whole page is built around.
//
// THE SUGGESTION IS TEXT AND NEVER A CONTROL. The inspect reply's suggestion
// vocabulary carries `escalate`, and the recovery request's does not: the wire admits
// three actions and there is no fourth to press. So the suggestion renders here as
// guidance beside the reading, and the controls live in the recovery prompt where the
// three that exist are offered. A button drawn for `escalate` would be a control whose
// press this console could not spell.

import type { ReactNode } from "react";

import { Chip, DerivedFigure, WireFigure, formatDuration } from "../../../primitives/index.js";
import type { GrowthStuckRunInspection } from "../../../bridge/index.js";
import { quietMillisecondsSince, stallTierFor, type StallTier } from "./stall-tier.js";

/** The chip tone each tier wears. `quiet` stays neutral: the daemon has only just said so. */
const TIER_TONES: Readonly<Record<StallTier, "neutral" | "attention" | "failure">> = {
  quiet: "neutral",
  noticed: "attention",
  escalated: "failure",
};

/** What each tier says about how long the quiet has lasted. */
const TIER_WORDS: Readonly<Record<StallTier, string>> = {
  quiet: "Just went quiet",
  noticed: "Quiet for a while",
  escalated: "Quiet for a long time",
};

export function StuckRunBadge(props: {
  readonly inspection: GrowthStuckRunInspection;
  readonly readAtMilliseconds: number;
}): ReactNode {
  const { inspection, readAtMilliseconds } = props;
  const quietMilliseconds = quietMillisecondsSince(inspection.lastProgressAt, readAtMilliseconds);
  const tier = stallTierFor(quietMilliseconds);
  if (inspection.healthSignal === "healthy") {
    return (
      <p className="meridian-stuck-badge meridian-stuck-badge--healthy">
        <Chip tone="neutral" label="Moving" glyph="check" />
        <span>
          This machine inspected <WireFigure value={inspection.runId} /> and reports it still making
          progress. Its state is <WireFigure value={inspection.currentState} />.
        </span>
      </p>
    );
  }
  return (
    <div className={`meridian-stuck-badge meridian-stuck-badge--${tier ?? "quiet"}`} role="status">
      <p className="meridian-stuck-badge__headline">
        <Chip
          tone={tier === undefined ? "attention" : TIER_TONES[tier]}
          label={tier === undefined ? "Suspected stuck" : TIER_WORDS[tier]}
          glyph="alert"
        />
        <span>
          This machine suspects <WireFigure value={inspection.runId} /> has stopped making progress.
          Its state is <WireFigure value={inspection.currentState} />.
        </span>
      </p>
      <p className="meridian-stuck-badge__interval">
        {quietMilliseconds === undefined ? (
          <>
            How long it has been quiet could not be worked out from the stamp this machine sent, so
            no duration is shown. The suspicion above is the node&rsquo;s own and stands either way.
          </>
        ) : (
          <>
            No progress for <DerivedFigure text={formatDuration(quietMilliseconds)} />, by this
            window&rsquo;s clock against the instant the node reported.
          </>
        )}
      </p>
      {inspection.blockingReason === undefined ? null : (
        <p className="meridian-stuck-badge__reason">
          The node says it is waiting on: <WireFigure value={inspection.blockingReason} />
        </p>
      )}
      {inspection.suggestedAction === undefined ? null : (
        <p className="meridian-stuck-badge__suggestion">
          The node suggests <WireFigure value={inspection.suggestedAction} />. That is guidance
          rather than a decision, and nothing here acts on it.
        </p>
      )}
    </div>
  );
}
