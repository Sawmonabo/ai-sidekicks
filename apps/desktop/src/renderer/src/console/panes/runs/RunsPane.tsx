// The runs pane's frame, and the place its reads will land.
//
// `Spec-023 §Console Design (Meridian)` §7.1 gives this pane a live spine of two
// session-scoped subscriptions and one snapshot, a nine-member status vocabulary
// taken verbatim from `RunState`, the seven run-state subtypes, the queue with its
// run-bound rows, and the intervention history including the attempts that failed.
// None of that is here yet, and the honest rendering of "not yet" is the one the
// five kinds of nothing already have a member for.
//
// `not-checked` RATHER THAN `not-loaded`. Nothing is in flight. The console has not
// asked, because the surface that would ask is not built — and a skeleton row would
// claim a read is on its way, which is the conflation those five kinds exist to
// prevent. The copy names the FEATURE that is absent, never the task that owns it:
// governance ids live in comments like this one and never in what a person reads.

import { Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { ConsolePaneChrome, paneScopeCrumbs } from "../pane-chrome.js";

export function RunsPane(context: ConsolePaneContext): React.JSX.Element {
  return (
    <ConsolePaneChrome
      kind="runs"
      leadingCrumbs={paneScopeCrumbs(context.entity)}
      focusHue={context.focusHue}
    >
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No run has been read into this pane yet."
        detail="Every run in the session, its live status, its queue, and its intervention history are read together and land here. The pane holds their place and asks nothing until it can answer."
      />
    </ConsolePaneChrome>
  );
}
