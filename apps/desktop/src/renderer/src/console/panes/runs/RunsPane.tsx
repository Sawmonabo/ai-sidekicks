// Every run in the session with its live status, its queue, and its intervention
// history, in one place that never invents a state.
//
// `Spec-023 §Console Design (Meridian)` §7.1 gives this pane a live spine of two
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
//   • **Nothing delivered yet.** `not-loaded` — a read IS in flight, the
//     subscription is open, and a skeleton is the honest shape.
//   • **Delivered, and there are no runs.** `empty`, with the start affordance
//     beside it. This is the one arm that may say "there are none", and it is
//     reachable only after the stream has spoken.
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

import { useCallback, useState } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { ConsolePaneChrome, paneScopeCrumbs } from "../pane-chrome.js";
import { QueueContents } from "./QueueContents.js";
import { RunInterventionComposer, type ComposedControl } from "./RunInterventionComposer.js";
import { RunRow } from "./RunRow.js";
import { useDeclaredCapabilities } from "./run-control-gating.js";
import { useRunControlSurface } from "./run-control-surface.js";
import { useQueueFeed } from "./queue-feed.js";
import { useRunStateFeed } from "./run-state-feed.js";

/** Which run is being composed against, and with which of the two body controls. */
interface ComposerTarget {
  readonly runId: string;
  readonly control: ComposedControl;
}

export function RunsPane(context: ConsolePaneContext): React.JSX.Element {
  return (
    <ConsolePaneChrome
      kind="runs"
      leadingCrumbs={paneScopeCrumbs(context.entity)}
      focusHue={context.focusHue}
    >
      {context.sessionStore === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This pane was opened outside a session."
          detail="Runs belong to a session, so there is nothing to read here. Open a session and the pane reads its runs, its queue, and the interventions raised against them."
        />
      ) : (
        <RunsPaneBody context={context} sessionId={context.sessionStore.sessionId} />
      )}
    </ConsolePaneChrome>
  );
}

/**
 * The pane's reads, held once for the whole pane.
 *
 * Split from the frame above so the hooks are never called conditionally: the
 * session check belongs at a boundary, and a body that runs only inside a session
 * is what keeps every subscription's lifetime the same as this component's.
 */
function RunsPaneBody(props: {
  readonly context: ConsolePaneContext;
  readonly sessionId: string;
}): React.JSX.Element {
  const { context, sessionId } = props;
  const stateFeed = useRunStateFeed(context.bridge, sessionId);
  const queueFeed = useQueueFeed(context.bridge, sessionId);
  const capabilities = useDeclaredCapabilities(context.bridge);
  const surface = useRunControlSurface(context.bridge);
  const [composerTarget, setComposerTarget] = useState<ComposerTarget | undefined>(undefined);

  const onRequestRewind = useCallback((runId: string) => {
    setComposerTarget({ runId, control: "rollback" });
  }, []);

  const onRequestSteer = useCallback((runId: string) => {
    setComposerTarget({ runId, control: "steer" });
  }, []);

  const onDismissComposer = useCallback(() => {
    setComposerTarget(undefined);
  }, []);

  const composedRun =
    composerTarget === undefined
      ? undefined
      : stateFeed.runs.find((run) => run.runId === composerTarget.runId);

  return (
    <div className="meridian-runs">
      <section className="meridian-runs__section" aria-label="Runs in this session">
        {stateFeed.runs.length === 0 ? (
          <NoRuns hasRead={stateFeed.hasRead} openRefusal={stateFeed.openRefusal} />
        ) : (
          <div className="meridian-runs__rows" role="feed" aria-label="Runs in this session">
            {stateFeed.runs.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                surface={surface}
                bridge={context.bridge}
                capabilities={capabilities}
                onRequestRewind={onRequestRewind}
                onRequestSteer={onRequestSteer}
              />
            ))}
          </div>
        )}
      </section>
      {composerTarget !== undefined && composedRun !== undefined ? (
        <section className="meridian-runs__section" aria-label="Compose an intervention">
          <RunInterventionComposer
            run={composedRun}
            control={composerTarget.control}
            surface={surface}
            onDismiss={onDismissComposer}
          />
        </section>
      ) : null}
      <section className="meridian-runs__section" aria-label="Queue">
        <h3 className="meridian-runs__section-title">Queue</h3>
        <QueueContents feed={queueFeed} />
      </section>
    </div>
  );
}

/**
 * Two different absences, told apart by whether the stream has spoken — and, ahead
 * of both, the refusal that says the stream was never opened.
 *
 * `empty` is only reachable once something was delivered — until then the honest
 * answer is that a read is in flight, and a skeleton says so without claiming the
 * session has no runs.
 */
function NoRuns(props: {
  readonly hasRead: boolean;
  readonly openRefusal: ConsoleRefusal | undefined;
}): React.JSX.Element {
  if (props.openRefusal !== undefined) {
    return <InlineRefusal code={props.openRefusal.code} detail={props.openRefusal.detail} />;
  }
  if (!props.hasRead) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the runs in this session." />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="No run has started in this session yet."
      detail="Send a message to an agent and its run appears here with its status, its queue, and every intervention raised against it."
    />
  );
}
