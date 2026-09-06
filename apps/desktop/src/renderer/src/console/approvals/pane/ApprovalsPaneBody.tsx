// The approvals pane's body: both reads, the lifecycle re-reads, and the two lists.
//
// Split from `ApprovalsPane.tsx`, which is now the pane seat and nothing else —
// resolve a session, mount this against it. Every hook below needs a session id to
// mean anything, so they live on the side of the boundary where one exists rather
// than behind a branch each would otherwise have to carry.

import { useEffect, useMemo, useRef, useState } from "react";
import { parseInstant } from "../../core/index.js";
import {
  consoleClockFor,
  foldSessionGoal,
  readingForDriver,
  readingForRun,
  useDriverCapabilities,
  type DriverCapabilityReading,
} from "../../bridge/index.js";
import {
  useDeadlineWake,
  useSessionPartition,
  useSessionStore,
  useSubjectScopedState,
  type ConsoleEntity,
  type SessionStore,
  type SessionStoreState,
} from "../../store/index.js";
import { type PaneContextOf } from "../../seats/index.js";
import { findApprovalCardAction } from "./card/ApprovalCard.js";
import { ApprovalList } from "./card/ApprovalList.js";
import { providerAskFor, type ProviderAsk } from "./card/provider-ask.js";
import { ExecutionPostureChip, Nothing, WireFigure } from "../../primitives/index.js";
import { addressedRunPostures } from "./posture/addressed-run-postures.js";
import { CALLBACK_TOOLS_CAPABILITY, CallbackTools } from "./posture/CallbackTools.js";
import { useCallbackToolRegistry } from "./posture/callback-tool-registry.js";
import { SessionGoalCard } from "./goal/SessionGoalCard.js";
import { useApprovalsReader, useSessionGoalMutation } from "./approvals-hooks.js";
import { useGoalMutationAuthorization } from "./goal/goal-authorization.js";
import { type ApprovalRecord } from "../../bridge/index.js";
import { type ReadPhase } from "./approvals-reader.js";
import { RulesRead } from "./RulesRead.js";

/** The composer's root class. Focus moves to a new card only from inside it. */
const COMPOSER_ROOT_SELECTOR = ".meridian-composer";

interface ApprovalsPaneBodyProps {
  readonly bridgeContext: PaneContextOf<"approvals">;
  readonly sessionStore: SessionStore;
}

function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}

export function ApprovalsPaneBody(props: ApprovalsPaneBodyProps): React.JSX.Element {
  const bridge = props.bridgeContext.bridge;
  const { snapshot, reader } = useApprovalsReader(bridge, props.sessionStore);
  const goalMutation = useSessionGoalMutation(bridge, props.sessionStore.sessionId);
  const goalAuthorization = useGoalMutationAuthorization(bridge, props.sessionStore);
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const goal = useMemo(() => foldSessionGoal(timeline), [timeline]);

  const pending = useMemo(() => partitionRecords(snapshot.approvals).pending, [snapshot.approvals]);
  const history = useMemo(() => partitionRecords(snapshot.approvals).history, [snapshot.approvals]);

  // The projected side of the same requests. The read answers the record and the
  // fold answers what the EVENT carried, and the provider-ask origin is only on the
  // second — so the two are joined here, by the id both spell, rather than either
  // one pretending to hold the whole request.
  const approvalEntities = useSessionPartition(props.sessionStore, "approval");
  // The runs this pane's decisions are about, and the boundary each executed under.
  // The partition is the store's own — the posture rides `run.running` into it like
  // every other event — so no second subscription is opened for one member.
  const runEntities = useSessionPartition(props.sessionStore, "run");
  const addressedPostures = useMemo(
    () => addressedRunPostures(pending, runEntities),
    [pending, runEntities],
  );
  // The node's declarations, resolved for the run a decision is about — the same
  // join the runs pane makes, because `driver.listCapabilities` names no run and a
  // node with two drivers installed would otherwise answer for the wrong one.
  const driverCapabilities = useDriverCapabilities(bridge);
  // Asked of the run a decision is about where there is one, and of the node's sole
  // declaration where there is not. The two are different questions and the empty
  // string is not the second one: an id no binding names would read as an unbound
  // run rather than as no run at all.
  const addressedRunId = addressedPostures[0]?.runId;
  const callbackToolCapability: DriverCapabilityReading =
    addressedRunId === undefined
      ? readingForDriver(driverCapabilities, undefined, CALLBACK_TOOLS_CAPABILITY)
      : readingForRun(driverCapabilities, addressedRunId, CALLBACK_TOOLS_CAPABILITY);
  const callbackToolRegistry = useCallbackToolRegistry(bridge, props.sessionStore.sessionId);
  const askByApprovalId = useMemo(() => providerAsksIn(approvalEntities), [approvalEntities]);
  // One clock, resolved once per bridge and read once per render. `consoleClockFor`
  // is the console's single answer to which clock a window reads — the fixture's
  // frozen one wherever a scenario is playing — and its real arm mints a fresh
  // instance per call, which is why the resolution is held rather than recomputed.
  // Held under the BRIDGE and not the mount: a `useState` seed runs once for the life
  // of the component, so a pane that outlived a scenario switch went on reading the
  // retired resolution's clock. `useConsoleClock` pins the same resolution for callers
  // that take their bridge from React context rather than, as a pane does, from the
  // seat it was mounted in. The deadline is shown as the instant the daemon sent plus
  // a reading of it against this; nothing here ticks.
  const { value: clock } = useSubjectScopedState(bridge, undefined, () => consoleClockFor(bridge));
  // Every ask's expiry, as the instants the countdown beside it crosses. An ask that
  // named no expiry, or named one this console could not read, arms nothing.
  const expiryDeadlines = useMemo(
    () =>
      [...askByApprovalId.values()].flatMap((ask) => {
        if (ask.expiryAt === undefined) {
          return [];
        }
        const expiry = parseInstant(ask.expiryAt);
        return expiry.kind === "instant" ? [expiry.epochMilliseconds] : [];
      }),
    [askByApprovalId],
  );
  // Woken once at each expiry rather than read in the render body. A render that read
  // the clock produced a countdown frozen at whatever instant React last happened to
  // run this pane for — so "expires in 30 seconds" stayed on screen after the ask had
  // expired, and the row a person was deciding about was the one row whose deadline
  // had passed. One timeout at a time, and none once every expiry is behind.
  const nowMilliseconds = useDeadlineWake(clock, expiryDeadlines);

  const paneRootRef = useRef<HTMLDivElement>(null);
  const announcement = useArrivalAnnouncement(pending, paneRootRef);

  return (
    <div className="meridian-approvals" ref={paneRootRef}>
      <SessionGoalCard
        // The subject the card's editor is held under, so a rebind to another
        // session opens on that session's own closed card rather than carrying a
        // draft written for the one before it.
        bridge={bridge}
        sessionId={props.sessionStore.sessionId}
        goal={goal}
        // Resolved rather than assumed: the caller-identity read chained to this
        // session's own roster answers which role this window holds, and the goal
        // contract admits an owner and a collaborator. A role still being read, one
        // whose read refused, and one the roster does not carry all leave this
        // undefined — the fail-closed arm — and the refusal beside it says which.
        canMutate={goalAuthorization.canMutate}
        authorizationRefusal={goalAuthorization.refusal}
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
          askByApprovalId={askByApprovalId}
          nowMilliseconds={nowMilliseconds}
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
          askByApprovalId={askByApprovalId}
          nowMilliseconds={nowMilliseconds}
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
        {addressedPostures.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="No decision is waiting, so no run's boundary is in question."
            detail="A boundary is stamped when a run reaches running, and this section reads the runs that raised the requests above."
          />
        ) : (
          addressedPostures.map((addressed) => (
            <div className="meridian-approvals__posture" key={addressed.runId}>
              <WireFigure value={addressed.runId} />
              <ExecutionPostureChip
                posture={addressed.posture}
                reading="stamped"
                runId={addressed.runId}
              />
            </div>
          ))
        )}
      </section>

      <section className="meridian-approvals__section" aria-label="Daemon-hosted tools">
        <h2 className="meridian-approvals__heading">Daemon-hosted tools</h2>
        <CallbackTools capability={callbackToolCapability} registry={callbackToolRegistry} />
      </section>
    </div>
  );
}

/**
 * The provider-ask origin of every projected approval, keyed by request id.
 *
 * Built over the whole partition rather than per rendered record: the partition's
 * identity changes only when an approval event lands, so one pass per fold serves
 * both lists, where a per-record lookup would rebuild on every render of either.
 */
function providerAsksIn(
  entities: Readonly<Record<string, ConsoleEntity>>,
): ReadonlyMap<string, ProviderAsk> {
  const asks = new Map<string, ProviderAsk>();
  for (const [approvalRequestId, entity] of Object.entries(entities)) {
    const ask = providerAskFor(entity);
    if (ask !== undefined) {
      asks.set(approvalRequestId, ask);
    }
  }
  return asks;
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
