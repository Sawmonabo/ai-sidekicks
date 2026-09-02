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

import { Chip, Nothing, RefusalCard, WireFigure, formatCount } from "../primitives/index.js";
import type { PushDrivenReadState } from "../collaboration/push-driven-read.js";
import { CHILD_RUN_REFUSAL_VISIBLE_CAP } from "./constants.js";
import {
  CHILD_RUN_LINK_TYPES,
  CHILD_RUN_VISIBILITIES,
  isKnownMember,
  type ChildRunLink,
  type ChildRunLinkReading,
  type ChildRunRejection,
} from "./agent-wire.js";

const LINK_TYPE_MEANINGS: Readonly<Record<string, string>> = {
  spawn: "a helper this run started; its output returns here",
  delegate: "a bounded task published to its own channel",
  handoff: "this run's continuation, transferred; the parent completed",
};

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
            {rejectedCreates.slice(0, CHILD_RUN_REFUSAL_VISIBLE_CAP).map((rejection, index) => (
              <RefusalRow key={`${rejection.reason}-${String(index)}`} rejection={rejection} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * One child link.
 *
 * An `internalHelper` row is de-emphasized and NEVER ejected: it stays in audit
 * history, and a list that dropped it would answer "what did this run start" with a
 * partial truth.
 */
function ChildLinkRow(props: {
  readonly link: ChildRunLink;
  readonly onOpen?: ((childRunId: string) => void) | undefined;
}): React.JSX.Element {
  const { link } = props;
  const meaning = isKnownMember(CHILD_RUN_LINK_TYPES, link.linkType)
    ? LINK_TYPE_MEANINGS[link.linkType]
    : undefined;
  return (
    <li
      className={`meridian-linkage__link${link.internalHelper ? " meridian-linkage__link--helper" : ""}`}
    >
      <span className="meridian-linkage__link-head">
        <Chip tone="neutral" mono label={link.linkType} />
        {props.onOpen === undefined ? (
          <WireFigure value={link.childRunId} />
        ) : (
          <button
            type="button"
            className="meridian-linkage__open"
            onClick={() => props.onOpen?.(link.childRunId)}
          >
            <WireFigure value={link.childRunId} />
          </button>
        )}
        {link.internalHelper ? <Chip tone="neutral" label="internal helper" /> : null}
      </span>
      <span className="meridian-linkage__link-meaning">
        {meaning ?? "a relationship this console does not know by name"}
      </span>
      <span className="meridian-linkage__link-state">
        {/* Anything that is not `reachable` takes the last-known treatment, including a
            member this console does not know: reading an unrecognized visibility as
            reachable would present a stale state as a live one, which is the one wrong
            answer on this axis. A known member is a caution; an unknown one is quoted. */}
        {link.visibility === "reachable" ? (
          link.state === undefined ? null : (
            <WireFigure value={link.state} />
          )
        ) : (
          <>
            <Chip
              tone={
                isKnownMember(CHILD_RUN_VISIBILITIES, link.visibility) ? "attention" : "neutral"
              }
              mono
              label={link.visibility}
            />
            <span className="meridian-linkage__last-known">
              Last known state{link.state === undefined ? " was not reported" : ": "}
              {link.state === undefined ? null : <WireFigure value={link.state} />}. This is a
              visibility outcome, not a run-state transition.
            </span>
          </>
        )}
      </span>
    </li>
  );
}

/** One refusal, rendered verbatim, with the depth limit taken from its own payload. */
function RefusalRow(props: { readonly rejection: ChildRunRejection }): React.JSX.Element {
  const { rejection } = props;
  return (
    <li className="meridian-linkage__refusal">
      <WireFigure value={rejection.reason} />
      {rejection.maxDepth === undefined ? null : (
        <span className="meridian-linkage__refusal-depth">
          {" "}
          The runtime allows {formatCount(rejection.maxDepth)} layer of nesting.
        </span>
      )}
      {rejection.detail === undefined ? null : (
        <span className="meridian-linkage__refusal-detail"> {rejection.detail}</span>
      )}
      {rejection.targetAgentId === undefined ? null : (
        <span className="meridian-linkage__refusal-target">
          {" "}
          Asked of <WireFigure value={rejection.targetAgentId} />.
        </span>
      )}
      {rejection.targetChannelId === undefined ? null : (
        <span className="meridian-linkage__refusal-target">
          {" "}
          In <WireFigure value={rejection.targetChannelId} />.
        </span>
      )}
    </li>
  );
}
