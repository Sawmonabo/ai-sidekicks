// The approvals pane: what needs a decision, what was decided, and what stands.
//
// `Spec-023 §Signature Feature Composition Sketches`' Approvals View names what
// this pane renders and forwards; how it is composed is this pane's own. It holds
// six surfaces over TWO reads, and three rules live in the composition rather than
// in any one card, each of them this pane's own because no committed document
// states it:
//
//   • **The read is unfiltered.** `approval.projectionRead` carries server-side
//     `state?` and `category?` filters and this pane passes neither, so history
//     renders every record the daemon returned with all five states labelled and
//     nothing dropped. The pending / history split below is a RENDERING of one
//     answered read, never a second read or a client-side filter of the wire.
//   • **Arrival is announced, and focus is not stolen.** A newly pending card is
//     announced through an assertive live region. Focus moves to THAT card's action
//     row — the arrived record's, found by its own approval id — and only when the
//     composer already held focus; a person mid-sentence anywhere else keeps their
//     caret.
//   • **The wait-for-all barrier is STATED, not inferred.** One turn may raise
//     several requests, one per contributing principal, and all of them must
//     resolve — the aggregate is approved only if every member approves, and the
//     first rejection or expiry refuses the whole set. No member of the read
//     groups those requests, so the pane states the rule over the pending group
//     and never claims that any two particular cards form a barrier. Inventing a
//     grouping key would assert a dependency the wire has not reported.
//
// One card per canonical record, and records of one category are never folded into
// a single action.

import { Nothing } from "../../primitives/index.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";
import { ApprovalsPaneBody } from "./ApprovalsPaneBody.js";

export function ApprovalsPane(context: PaneContextOf<"approvals">): React.JSX.Element {
  const { sessionStore } = context;
  return (
    <ConsolePaneChrome
      kind="approvals"
      // The pane's own binding rather than the route, on the runs pane's reason.
      sessionId={sessionStore?.sessionId}
      focusHue={context.focusHue}
    >
      {sessionStore === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This pane is not bound to a session."
          detail="Approvals belong to a session, so nothing is read until one is open. An empty queue and an unbound pane are different facts and this is the second one."
        />
      ) : (
        <ApprovalsPaneBody bridgeContext={context} sessionStore={sessionStore} />
      )}
    </ConsolePaneChrome>
  );
}
