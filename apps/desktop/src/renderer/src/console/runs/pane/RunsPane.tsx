// Every run in the session with its live status, its queue, and its intervention
// history, in one place that never invents a state.
//
// `Spec-023 §Signature Feature Composition Sketches`' Runs View names the pane's
// data sources — "daemon run-state subscription per Spec-004; daemon queue
// subscription per Spec-004" — and this pane reads them as a live spine of two
// session-scoped subscriptions and one snapshot: `run.subscribeState` streaming
// `RunStateChangeEvent | RunRolledBackEvent`, `run.subscribeQueue` streaming
// `QueueItemSummary`, and the `run.queueList` snapshot. Both subscriptions are
// session-scoped and the fan-out per run is client-side, on the event's own
// `runId` — which is what `run-state-feed.ts` does.
//
// WHAT EACH ABSENCE MEANS, AND WHY THEY ARE DIFFERENT SENTENCES.
//
//   • **No session.** The pane is addressed within a session; opened on a bare
//     route there is nothing to read and no read to wait for.
//   • **Nothing delivered yet.** `not-loaded` — a read IS in flight, the session's
//     snapshot has not landed, and a skeleton is the honest shape.
//   • **Delivered, and there are no runs.** `empty`, with the start affordance
//     beside it. This is the one arm that may say "there are none", and it is
//     reachable only once the snapshot has landed naming none.
//
// And two things that are none of the three. A stream that is open and answering
// while some of what it answered parsed as neither registered arm: not an absence
// and not a refusal — the feed is live and partial at once — so it renders as a
// sentence BESIDE the rows rather than in place of them, and settles nothing, which
// is why it announces nothing. And a run the session's own record knows that the
// live tail has not described, which is neither missing nor current: it draws its
// row from `run-seating.ts` and the pane names how many such rows it is drawing and
// which runs they are, because a list that quietly omitted them would read as a
// session with fewer runs than it has.
//
// The three are `Spec-023`'s five kinds of nothing applied as they are meant to be:
// "we have not asked", "we are asking", and "there is none" are three facts and the
// pane never lets one stand in for another.
//
// WHAT THE PANE DOES NOT DO. It never sums the run rows into a session total —
// summing the runs visible in a run list is expressly not a permitted derivation,
// and the receipt has its own single accountant elsewhere. It holds no queue in
// client memory as the record: the queue's rows come from the daemon's snapshot and
// its tail, and cancel changes a row only when the daemon says it changed.

import { Nothing } from "../../primitives/index.js";
import { ConsolePaneChrome, paneScopeCrumbs, type PaneContextOf } from "../../panes/pane-chrome.js";
import { RunsPaneBody } from "./RunsPaneBody.js";

export function RunsPane(context: PaneContextOf<"runs">): React.JSX.Element {
  return (
    <ConsolePaneChrome kind="runs" leadingCrumbs={paneScopeCrumbs()} focusHue={context.focusHue}>
      {context.sessionStore === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This pane was opened outside a session."
          detail="Runs belong to a session, so there is nothing to read here. Open a session and the pane reads its runs, its queue, and the interventions raised against them."
        />
      ) : (
        <RunsPaneBody context={context} sessionStore={context.sessionStore} />
      )}
    </ConsolePaneChrome>
  );
}
