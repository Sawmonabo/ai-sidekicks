// A start the daemon refused, and — where it refused on the role — what the roles are.
//
// THE MESSAGE IS THE DAEMON'S, VERBATIM. `workflow.start_denied` is one code covering
// ordered arms with scoped disclosure: the role arm first, the membership validation
// second, and the two are deliberately one byte-identical sentence where saying more
// would disclose whether a channel exists. So nothing here paraphrases it, appends to it,
// or decides which arm was taken.
//
// THE MATRIX RIDES THE CODE AND NOT THE SENTENCE. It is rendered for this one code and
// for no other refusal a start can meet, because it answers this refusal's question —
// who may start one — and would be noise beside a run that failed for any other reason.
//
// AND IT IS RENDERED AFTER THE FACT, NEVER BEFORE. The control that produced this refusal
// is still there and still offered; this surface is the console's inline shape, which is
// what "nothing changed, try something else" looks like.

import { InlineRefusal } from "../../primitives/index.js";
import { WORKFLOW_START_DENIED_CODE, WORKFLOW_START_ROLE_MATRIX } from "./start-role-matrix.js";

export interface WorkflowStartDenialProps {
  readonly code: string;
  readonly detail: string;
}

/** The daemon's refusal, with the public role matrix where the code is the denial. */
export function WorkflowStartDenial(props: WorkflowStartDenialProps): React.JSX.Element {
  return (
    <div className="meridian-workflow-start-menu__refusal">
      <InlineRefusal code={props.code} detail={props.detail} />
      {props.code === WORKFLOW_START_DENIED_CODE ? (
        <dl className="meridian-workflow-start-menu__roles">
          {WORKFLOW_START_ROLE_MATRIX.map((row) => (
            <div className="meridian-workflow-start-menu__role" key={row.role}>
              <dt>{row.role}</dt>
              <dd>{row.mayStart ? "may start a workflow" : "may not start a workflow"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
