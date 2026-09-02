// The approvals pane's frame, and the place its reads will land.
//
// `Spec-023 §Console Design (Meridian)` §7.6 gives this pane pending cards carrying
// the nine canonical categories, the five-member approval state, the two-member
// decision, the resolved quad, a verbatim expiry with an explicit "no expiry" label,
// the wait-for-all barrier where one turn raised several requests, and a history
// that drops nothing. None of it is here yet.
//
// `not-checked` RATHER THAN `empty`. "Nothing needs a decision" is a real answer
// this pane will give, and it is a different sentence from "the console has not
// asked" — rendering the former before the read exists would synthesise a state the
// daemon has not served, which §7.6's own Never list forbids in as many words.

import { Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { ConsolePaneChrome, paneScopeCrumbs } from "../pane-chrome.js";

export function ApprovalsPane(context: ConsolePaneContext): React.JSX.Element {
  return (
    <ConsolePaneChrome
      kind="approvals"
      leadingCrumbs={paneScopeCrumbs(context.entity)}
      focusHue={context.focusHue}
    >
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The console has not asked what needs a decision."
        detail="Pending requests, the scope each one would remember, and the resolved history are read together and land here. Until that read exists this pane asks nothing, so an empty pane never stands in for an empty queue."
      />
    </ConsolePaneChrome>
  );
}
