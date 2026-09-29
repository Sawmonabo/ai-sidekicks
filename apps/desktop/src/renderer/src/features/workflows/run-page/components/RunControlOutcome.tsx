// What one run control answered, rendered beside the button that asked.
//
// A SIBLING RATHER THAN A THIRD RENDER FUNCTION IN `OperatorControls.tsx`, for the
// reason `RunParks.tsx` and `ParkFormRoute.tsx` beside it state: one component per
// `.tsx`, reached by a deep relative import from its host and published through no
// door line. It is also a different concern from either renderer there — those own
// the form an operator fills in, and this owns what came back — and the two arms that
// matter here are reached from a call rather than from a field.
//
// THE CONTROL STAYS. Every arm below renders BESIDE the button rather than in place
// of it: rule 9 is that nothing changed, the act did not happen, and the control stays
// beside its refusal. A refusal that replaced the control would leave an operator with
// nothing to press once the daemon's answer stopped applying, and the surface would
// have to guess when to put it back.
//
// AND THE REFUSAL IS RENDERED VERBATIM. It is this family's own — a second press, or a
// reason past the bound — and the code and the sentence are the raiser's; this file
// composes no copy of its own on that arm.
//
// `idle` DRAWS NOTHING, AND THAT IS NOT AN OMISSION. A control nobody has pressed has
// no outcome, and an absence primitive there would be the console reporting on a
// question that was never put — the conflation the five kinds of nothing exist to
// prevent, with the empty case standing in for "we have not asked".

import { InlineRefusal, Nothing, WireFigure } from "@renderer/console/primitives/index.js";
import type { WorkflowRunControlOutcome } from "../run-controls.js";

/** Where the last press of one control got to, or nothing while there has been none. */
export function RunControlOutcome(props: {
  readonly outcome: WorkflowRunControlOutcome;
}): React.JSX.Element | null {
  const { outcome } = props;
  switch (outcome.kind) {
    case "idle":
      return null;
    case "dispatching":
      // `not-loaded` and never `computing`: the answer is a round trip that has been
      // put and is still coming, which is the kind that stands in for copy arriving a
      // beat later. `computing` would claim this console is working something out.
      return (
        <Nothing kind="not-loaded" placement="inline" title="Waiting for the background service." />
      );
    case "settled":
      return (
        <p className="meridian-workflow-run-controls__outcome">
          <WireFigure value={outcome.runState} />
          <span>{outcome.detail}</span>
        </p>
      );
    case "refused":
      return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
}
