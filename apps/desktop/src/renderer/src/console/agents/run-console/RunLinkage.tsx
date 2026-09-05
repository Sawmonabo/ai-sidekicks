// What a run started, what it asked for and was refused, and how deep it may go.
//
// THREE RELATIONSHIPS, NOT ONE WORD. `spawn` is a parent-initiated helper whose
// output returns to the parent's channel context; `delegate` is a bounded task
// published to its own target channel; `handoff` is the parent transferring its
// continuation to the child and completing. Peer-invoked children are ordinary
// children — `ask_sidekick` produces a `spawn` link and `delegate_to_sidekick` a
// `delegate` one — and no run kind, link type, or scheduler rule is added for them.
//
// THE REFUSAL FOLD IS THE POINT. A refusal is zero-residue: no run, no queue entry,
// no link row. This fold is therefore the ONLY path by which work that was asked for
// and denied is visible at all, which is why a refusal is never hidden because the
// run it would have created never existed.
//
// WHICH IS WHY THE LIST IS NOT CAPPED. Refusals accumulate for the life of a run and
// nothing collects them, so the collection is unbounded by construction — and the
// answer to that is a bounded REGION, not a bounded list. The group carries a
// `max-height` and scrolls; every row is rendered inside it, so the disclosure's
// count and the rows a person can reach are the same number. A slice here reported
// a count it then declined to show, and the rows it dropped were the only record
// their work was ever asked for. There is no pagination either: no refusal read
// carries a cursor, so a "more" control would have nothing to ask.
//
// FOUR THINGS IT REFUSES TO DERIVE
//
//   • `visibility` — daemon-projected from node liveness, never inferred, and an
//     `unreachable` row keeps its last-known `state` labelled as a VISIBILITY
//     outcome rather than as a run-state transition.
//   • The depth limit — read from the refusal's own payload, never from a constant.
//   • Cost — the receipt reads the parent-child link and this view sums nothing.
//   • `invoking_principal_id` — daemon-resolved; a child whose creation cannot
//     resolve one is refused rather than created unattributed, and it is not shown.
//
// AND ONE CONTROL IT DOES NOT OFFER: a subtree cascade. A pause, interrupt, or steer
// on a parent does not reach its children, and propagating one means submitting one
// intervention per run — so a "cancel subtree" control would have no wire and would
// break the per-run audit property. There is no run-create affordance here either:
// child runs are created by the SDK, the CLI, workflows, and peer invocation.

import { Nothing, RefusalCard, formatCount } from "../../primitives/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { type ChildRunLinkReading } from "../../bridge/index.js";
import { ChildLinkRow } from "./ChildLinkRow.js";
import { RefusalRow } from "./RefusalRow.js";

export interface RunLinkageProps {
  /** The parent run the read is keyed by. `undefined` renders the absence. */
  readonly parentRunId: string | undefined;
  readonly state: PushDrivenReadState<ChildRunLinkReading> | undefined;
  /** Renderer-local navigation into a child's own run surface. */
  readonly onOpenChildRun?: ((childRunId: string) => void) | undefined;
}

export function RunLinkage(props: RunLinkageProps): React.JSX.Element {
  if (props.parentRunId === undefined || props.state === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No run of this agent is on the timeline yet."
        detail="Child links and refusals are read per run, so there is nothing to ask about until this agent has started one."
      />
    );
  }
  if (props.state.kind === "not-loaded") {
    return <Nothing kind="not-loaded" title="Reading what this run started" />;
  }
  if (props.state.kind === "failed") {
    return <RefusalCard {...props.state.refusal} />;
  }

  const { links, rejectedCreates } = props.state.value;
  return (
    <section className="meridian-linkage" aria-label="What this run started">
      {links.length === 0 ? (
        <Nothing
          kind="empty"
          title="This run started nothing."
          detail="No helper, no delegated task, and no handoff."
        />
      ) : (
        <ul className="meridian-linkage__links">
          {links.map((link) => (
            <ChildLinkRow key={link.childRunId} link={link} onOpen={props.onOpenChildRun} />
          ))}
        </ul>
      )}

      {rejectedCreates.length === 0 ? null : (
        <details className="meridian-linkage__refusals">
          <summary className="meridian-linkage__refusals-summary">
            {formatCount(rejectedCreates.length)} refused
          </summary>
          <ul className="meridian-linkage__refusal-list">
            {rejectedCreates.map((rejection, index) => (
              <RefusalRow key={`${rejection.reason}-${String(index)}`} rejection={rejection} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
