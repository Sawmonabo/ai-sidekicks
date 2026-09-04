// What this agent's newest run started, and which run the reading on screen is of.
//
// The read is keyed by a PARENT RUN and this console is scoped to an agent, so the
// two are related through the store's own run projection and through no wire
// question the daemon answers. Where no run has been attributed to this agent, the
// surface renders that absence rather than an empty result.
//
// THE READ IS TAKEN FROM AN EFFECT AND NEVER FROM THE RENDER BODY. Starting one
// opens a subscription and arms a scheduler, and React may abandon or replay a
// render pass — an abandoned one would leave a live read with no cleanup to release
// it, and a replayed one would dispose a read the committed tree is still showing.
//
// WHICH IS WHY THE HELD READ CARRIES THE RUN IT WAS ACQUIRED FOR. Taking it from an
// effect means the run this pane is keyed by moves one committed frame BEFORE the
// read does: the projection names a newer run, the component re-renders with the new
// id, and the effect that re-leases has not run yet. An unstamped read renders that
// frame as the new run's heading over the previous run's child links and refusals —
// a reading of one run presented as a reading of another, which is worse than no
// reading at all. So the acquisition records its own run, and a reading is shown
// only while the two agree.
//
// This is the same rule two other holders in this pane already keep, arrived at from
// the same direction: `AgentBindingColumn` records the agent a mutation was
// submitted for and renders its settlement only under that agent, and
// `PeerInvocationMount` stamps a reply with the session it was asked of. All three
// compare at RENDER rather than in an effect, because an effect leaves exactly the
// one committed frame the rule exists to prevent.

import { useEffect, useState } from "react";

import {
  RunLinkage,
  useNewestRunIdForAgent,
  type AgentConsoleModels,
  type ChildRunLinkageRead,
} from "../../agents/index.js";
import { usePushDrivenRead } from "../../seats/index.js";
import type { SessionStore } from "../../store/index.js";

/** One acquired child-link read, with the parent run it answers for. */
export interface AcquiredLinkage {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}

/**
 * The read to render for `parentRunId`, or `undefined` for the not-checked absence.
 *
 * A pure function rather than an expression inside the body, so the rule can be
 * driven directly with an acquisition whose verdict is known — the mismatched frame
 * it exists to catch is transient in the DOM and is not observable after `act` has
 * flushed the effect that ends it.
 */
export function linkageReadFor(
  acquired: AcquiredLinkage | undefined,
  parentRunId: string,
): ChildRunLinkageRead | undefined {
  if (acquired === undefined || acquired.parentRunId !== parentRunId) {
    return undefined;
  }
  return acquired.read;
}

/**
 * The child-link read for this agent's newest run.
 *
 * Mounted with whatever the pane resolved; the arms below narrow it, because hooks
 * cannot be called conditionally and every half here is legitimately absent in some
 * address the frame can produce.
 */
export function RunLinkageMount(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly sessionStore: SessionStore | undefined;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const { models, sessionStore, agentId } = props;
  if (models === undefined || sessionStore === undefined) {
    return <RunLinkage parentRunId={undefined} state={undefined} />;
  }
  return <SubscribedRunLinkage models={models} sessionStore={sessionStore} agentId={agentId} />;
}

/** The subscribed arm: the linkage is re-keyed whenever the run partition moves. */
function SubscribedRunLinkage(props: {
  readonly models: AgentConsoleModels;
  readonly sessionStore: SessionStore;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const parentRunId = useNewestRunIdForAgent(props.sessionStore, props.agentId);
  if (parentRunId === undefined) {
    return <RunLinkage parentRunId={undefined} state={undefined} />;
  }
  return <ResolvedRunLinkage models={props.models} parentRunId={parentRunId} />;
}

/**
 * The mounted arm, where both halves exist and the read may be taken.
 *
 * The frame between the render that names a run and the effect that leases its read
 * holds no reading, and neither does the frame between a re-key and its re-lease —
 * both render as the `not-checked` absence the surface already has for a question
 * nothing was asked of.
 */
function ResolvedRunLinkage(props: {
  readonly models: AgentConsoleModels;
  readonly parentRunId: string;
}): React.JSX.Element {
  const { models, parentRunId } = props;
  const [acquired, setAcquired] = useState<AcquiredLinkage | undefined>(undefined);

  useEffect(() => {
    const lease = models.acquireLinkage(parentRunId);
    lease.read.start();
    setAcquired({ parentRunId, read: lease.read });
    return () => {
      lease.release();
      setAcquired(undefined);
    };
  }, [models, parentRunId]);

  const read = linkageReadFor(acquired, parentRunId);
  if (read === undefined) {
    return <RunLinkage parentRunId={parentRunId} state={undefined} />;
  }
  return <HeldRunLinkage parentRunId={parentRunId} read={read} />;
}

/** The arm where a read is held, so the hook that reads it may be called. */
function HeldRunLinkage(props: {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}): React.JSX.Element {
  const state = usePushDrivenRead(props.read);
  return <RunLinkage parentRunId={props.parentRunId} state={state} />;
}
