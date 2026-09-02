// The approvals pane: what needs a decision, what was decided, and what stands.
//
// `Spec-023 §Console Design (Meridian)` §7.6 — §7.11. The pane composes six
// surfaces over TWO reads, and the composition is where three of the design's
// rules live rather than in any one card:
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

import { useEffect, useMemo, useRef, useState } from "react";

import { Nothing } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { useSessionStore, type SessionStore, type SessionStoreState } from "../../store/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { ConsolePaneChrome, paneScopeCrumbs } from "../pane-chrome.js";
import { ApprovalCard, findApprovalCardAction } from "./ApprovalCard.js";
import { ExecutionPostureChip } from "./ExecutionPosture.js";
import { CallbackTools } from "./CallbackTools.js";
import { RememberedGrants } from "./RememberedGrants.js";
import { SessionGoalCard } from "./SessionGoalCard.js";
import { useApprovalsReader, useSessionGoalMutation } from "./approvals-hooks.js";
import { type ApprovalRecord, type RememberedRule } from "./approval-records.js";
import { type ReadPhase } from "./approvals-reader.js";
import { type ApprovalResolveRequest } from "./approvals-wire.js";
import { foldSessionGoal } from "./session-goal.js";

/** The composer's root class. Focus moves to a new card only from inside it. */
const COMPOSER_ROOT_SELECTOR = ".meridian-composer";

export function ApprovalsPane(context: ConsolePaneContext): React.JSX.Element {
  const { sessionStore } = context;
  return (
    <ConsolePaneChrome
      kind="approvals"
      leadingCrumbs={paneScopeCrumbs(context.entity)}
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

interface ApprovalsPaneBodyProps {
  readonly bridgeContext: ConsolePaneContext;
  readonly sessionStore: SessionStore;
}

function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}

function ApprovalsPaneBody(props: ApprovalsPaneBodyProps): React.JSX.Element {
  const bridge = props.bridgeContext.bridge;
  const { snapshot, reader } = useApprovalsReader(bridge, props.sessionStore);
  const goalMutation = useSessionGoalMutation(bridge, props.sessionStore.sessionId);
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const goal = useMemo(() => foldSessionGoal(timeline), [timeline]);

  const pending = useMemo(() => partitionRecords(snapshot.approvals).pending, [snapshot.approvals]);
  const history = useMemo(() => partitionRecords(snapshot.approvals).history, [snapshot.approvals]);

  const paneRootRef = useRef<HTMLDivElement>(null);
  const announcement = useArrivalAnnouncement(pending, paneRootRef);

  return (
    <div className="meridian-approvals" ref={paneRootRef}>
      <SessionGoalCard
        goal={goal}
        // The role read this control is gated on is not on this pane's wire, and a
        // renderer never derives an eligibility — so the control is absent, which
        // is the same thing a read-only role sees and the fail-closed arm.
        canMutate={undefined}
        isMutating={goalMutation.isMutating}
        refusal={goalMutation.refusal}
        onUpdate={goalMutation.update}
        onClear={goalMutation.clear}
      />

      <p className="meridian-visually-hidden" role="status" aria-live="assertive">
        {announcement}
      </p>

      <section className="meridian-approvals__section" aria-label="Waiting on a decision">
        <h2 className="meridian-approvals__heading">Waiting on a decision</h2>
        <p className="meridian-approvals__barrier-note">
          Where one turn raised several requests — one for each contributing principal — every one
          of them has to be answered. The set is approved only if all of them are approved, and the
          first rejection or expiry refuses the whole set.
        </p>
        <ApprovalList
          phase={snapshot.approvals}
          records={pending}
          emptyTitle="Nothing needs a decision."
          emptyDetail="Every request this session raised has been answered. A new one appears here the moment an agent asks."
          snapshotResolving={snapshot.resolvingApprovalIds}
          refusalByApprovalId={snapshot.resolveRefusalByApprovalId}
          onResolve={(request) => {
            reader.resolve(request);
          }}
        />
      </section>

      <section className="meridian-approvals__section" aria-label="Decision history">
        <h2 className="meridian-approvals__heading">Decision history</h2>
        <ApprovalList
          phase={snapshot.approvals}
          records={history}
          emptyTitle="No request has been resolved yet."
          emptyDetail="Approved, rejected, expired and canceled records all land here, labelled with the state the daemon gave them."
          snapshotResolving={snapshot.resolvingApprovalIds}
          refusalByApprovalId={snapshot.resolveRefusalByApprovalId}
          onResolve={(request) => {
            reader.resolve(request);
          }}
        />
      </section>

      <section className="meridian-approvals__section" aria-label="Standing permissions">
        <h2 className="meridian-approvals__heading">Standing permissions</h2>
        <RulesRead
          phase={snapshot.rules}
          revokingRuleIds={snapshot.revokingRuleIds}
          revokeRefusalByRuleId={snapshot.revokeRefusalByRuleId}
          onRevoke={(ruleId) => {
            reader.revokeRule(ruleId);
          }}
        />
      </section>

      <section className="meridian-approvals__section" aria-label="Execution boundary">
        <h2 className="meridian-approvals__heading">Execution boundary</h2>
        {/* A posture is stamped on `run.running` and travels on the run-state
            subscription, which this pane does not open — the runs surface does.
            So the absence is rendered rather than a boundary guessed at. */}
        <ExecutionPostureChip posture={undefined} reading="stamped" />
      </section>

      <section className="meridian-approvals__section" aria-label="Daemon-hosted tools">
        <h2 className="meridian-approvals__heading">Daemon-hosted tools</h2>
        <CallbackTools capability={undefined} isWithheld={false} tools={[]} />
      </section>
    </div>
  );
}

interface ApprovalListProps {
  readonly phase: ReadPhase<ApprovalRecord>;
  readonly records: readonly ApprovalRecord[];
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly snapshotResolving: ReadonlySet<string>;
  readonly refusalByApprovalId: ReadonlyMap<string, ConsoleRefusal>;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
}

/**
 * One read, rendered in each of its four phases.
 *
 * The four are kept apart deliberately: "nobody asked", "the read is in flight",
 * "the read answered and found none", and "the read was refused" are four different
 * next moves for the operator, and rule 8 forbids collapsing any two of them.
 */
function ApprovalList(props: ApprovalListProps): React.JSX.Element {
  if (props.phase.status === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The console has not asked what needs a decision."
        detail="Nothing has been read yet, so an empty list here would stand in for an answer nobody has given."
      />
    );
  }
  if (props.phase.status === "loading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading the approval queue." />;
  }
  if (props.phase.status === "refused") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={props.phase.refusal.code}
        detail={props.phase.refusal.detail}
      />
    );
  }
  if (props.records.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={props.emptyTitle}
        detail={props.emptyDetail}
      />
    );
  }
  return (
    <div className="meridian-approvals__cards">
      {props.phase.unreadableCount > 0 ? (
        <p className="meridian-approvals__unreadable">
          The reply carried records this build could not read, so this list is shorter than what the
          daemon returned.
        </p>
      ) : null}
      {props.records.map((record) => (
        <ApprovalCard
          key={record.approvalRequestId}
          record={record}
          isResolving={props.snapshotResolving.has(record.approvalRequestId)}
          refusal={props.refusalByApprovalId.get(record.approvalRequestId)}
          onResolve={props.onResolve}
        />
      ))}
    </div>
  );
}

interface RulesReadProps {
  readonly phase: ReadPhase<RememberedRule>;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly revokeRefusalByRuleId: ReadonlyMap<string, ConsoleRefusal>;
  readonly onRevoke: (ruleId: string) => void;
}

function RulesRead(props: RulesReadProps): React.JSX.Element {
  if (props.phase.status === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Standing permissions have not been read."
      />
    );
  }
  if (props.phase.status === "loading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading standing permissions." />;
  }
  if (props.phase.status === "refused") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={props.phase.refusal.code}
        detail={props.phase.refusal.detail}
      />
    );
  }
  return (
    <RememberedGrants
      rules={props.phase.rows}
      unreadableCount={props.phase.unreadableCount}
      revokingRuleIds={props.revokingRuleIds}
      revokeRefusalByRuleId={props.revokeRefusalByRuleId}
      onRevoke={props.onRevoke}
    />
  );
}

/**
 * Split one answered read into the pending cards and the history.
 *
 * A rendering of ONE read rather than two reads or a filter of the wire: every
 * record the daemon returned appears in exactly one of the two lists, so the
 * history's "drops nothing" claim survives the split.
 */
function partitionRecords(phase: ReadPhase<ApprovalRecord>): {
  readonly pending: readonly ApprovalRecord[];
  readonly history: readonly ApprovalRecord[];
} {
  if (phase.status !== "answered") {
    return { pending: [], history: [] };
  }
  const pending: ApprovalRecord[] = [];
  const history: ApprovalRecord[] = [];
  for (const record of phase.rows) {
    if (record.state === "pending") {
      pending.push(record);
    } else {
      history.push(record);
    }
  }
  return { pending, history };
}

/**
 * Announce a newly pending card, and move focus only when the composer had it.
 *
 * The focus rule is the sharp half, and it has two parts. WHETHER focus moves is a
 * question about where focus already is: a person typing in the composer is looking
 * at the work and has asked for nothing else, while a person reading a diff, or
 * mid-sentence in a field this pane knows nothing about, has not. WHERE it moves is
 * a question about which record arrived — the announcement names that record, so
 * landing the caret on an older card's button describes one request and hands over
 * another. Both the pane root and the record are named rather than assumed: a
 * document-wide query for the first action in DOM order answers with neither.
 */
function useArrivalAnnouncement(
  pending: readonly ApprovalRecord[],
  paneRootRef: React.RefObject<HTMLElement | null>,
): string {
  const [announcement, setAnnouncement] = useState("");
  const seenIdsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(pending.map((record) => record.approvalRequestId));
    const arrived = pending.filter((record) => !seenIdsRef.current.has(record.approvalRequestId));
    seenIdsRef.current = currentIds;
    if (arrived.length === 0) {
      return;
    }
    const first = arrived[0];
    if (first === undefined) {
      return;
    }
    setAnnouncement(
      arrived.length === 1
        ? `A decision is waiting: ${first.category} requested by ${first.requestedBy}.`
        : `${String(arrived.length)} decisions are waiting.`,
    );
    if (typeof document === "undefined") {
      return;
    }
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused.closest(COMPOSER_ROOT_SELECTOR) === null) {
      return;
    }
    // Scoped to this pane, because a deck may hold a second one and its cards are
    // no more this arrival's than an older card of this pane's is.
    const action = findApprovalCardAction(paneRootRef.current ?? document, first.approvalRequestId);
    action?.focus();
  }, [pending, paneRootRef]);

  return announcement;
}
