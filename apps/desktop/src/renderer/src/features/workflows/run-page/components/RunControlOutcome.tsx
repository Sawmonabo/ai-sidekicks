// What one run control answered, rendered beside the button that asked, never in place of it, so
// the operator still has something to press after a refusal. A refusal is rendered verbatim
// (code and sentence are the raiser's). `idle` draws nothing: an unpressed control has no
// outcome to report.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
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
      // `not-loaded`, not `computing`: the answer is a round trip still coming.
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
