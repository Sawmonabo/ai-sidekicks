// The approvals pane's body: three reads, the lifecycle re-reads, and the sections
// each of them answers for.
//
// Split from `ApprovalsPane.tsx`, which is now the pane seat and nothing else —
// resolve a session, mount this against it. Every hook below needs a session id to
// mean anything, so they live on the side of the boundary where one exists rather
// than behind a branch each would otherwise have to carry.
//
// WHAT STAYS HERE IS COMPOSITION. The folds over the reads, the two sections whose
// rendering is a decision rather than a layout, and the arrival announcement each
// live in `body/` beside this file: this module resolves the reads, hands each
// section what it renders from, and takes exactly one decision of its own — which
// refusal stops being this pane's business and reaches the frame.
//
// THREE CALLS GO OUT FROM HERE AND ANY OF THEM CAN END THE SESSION. The approval
// projection, the standing-rule list, and the node's declared capabilities are
// independent reads that fail independently, so `session.not_found` on any one of
// them is a fact about the whole workspace. It used to be selected from the first
// alone, which left a session that vanished between two concurrent calls reported
// inside one surface and nowhere else.

import { useMemo, useRef } from "react";
import { parseInstant } from "../../core/index.js";
import {
  consoleClockFor,
  foldSessionGoal,
  readingAcrossRuns,
  useDriverCapabilities,
} from "../../bridge/index.js";
import {
  preferredBannerClassRefusalAmong,
  useDeadlineWake,
  useSessionPartition,
  useSessionStore,
  useRefusalBannerEscalation,
  useSubjectScopedState,
  type SessionStore,
  type SessionStoreState,
} from "../../store/index.js";
import { type PaneContextOf } from "../../seats/index.js";
import { ApprovalList } from "./card/ApprovalList.js";
import { addressedRunPostures } from "./posture/addressed-run-postures.js";
import { CALLBACK_TOOLS_CAPABILITY } from "./posture/CallbackTools.js";
import { useCallbackToolRegistry } from "./posture/callback-tool-registry.js";
import { SessionGoalCard } from "./goal/SessionGoalCard.js";
import { useApprovalCommands } from "./approval-commands.js";
import { useApprovalsReader, useSessionGoalMutation } from "./approvals-hooks.js";
import { useArrivalAnnouncement } from "./body/arrival-announcement.js";
import { partitionRecords, providerAsksIn, refusalOfPhase } from "./body/approvals-read-fold.js";
import { DaemonHostedToolsSection } from "./body/DaemonHostedToolsSection.js";
import { ExecutionBoundaryReading } from "./body/ExecutionBoundaryReading.js";
import { RulesRead } from "./RulesRead.js";

export function ApprovalsPaneBody(props: ApprovalsPaneBodyProps): React.JSX.Element {
  const bridge = props.bridgeContext.bridge;
  const { snapshot, reader } = useApprovalsReader(
    bridge,
    props.sessionStore,
    props.bridgeContext.frameStore,
  );
  const goalMutation = useSessionGoalMutation(
    bridge,
    props.sessionStore.sessionId,
    props.bridgeContext.frameStore,
  );
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const goal = useMemo(() => foldSessionGoal(timeline), [timeline]);

  // One fold per read rather than one per list: the two arrays are halves of a single
  // partition, and computing it twice made the pending half's identity change on a
  // render the history half had caused.
  const partitioned = useMemo(() => partitionRecords(snapshot.approvals), [snapshot.approvals]);
  const pending = partitioned.pending;

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
  // The node's declarations, resolved for the runs the decisions are about — the same
  // join the runs pane makes, because `driver.listCapabilities` names no run and a
  // node with two drivers installed would otherwise answer for the wrong one.
  const driverCapabilities = useDriverCapabilities(bridge);
  // Asked of EVERY run a decision is about, and of the node's sole declaration where
  // there is none. Reading the first addressed run and reporting its answer for the
  // rest made this section's claim depend on the order the records arrived in, while
  // the bindings behind them stood still; `readingAcrossRuns` folds the whole set, so
  // reordering the queue cannot move the answer. The empty-set arm is the second
  // question and not the same one asked of nothing: an id no binding names would read
  // as an unbound run rather than as no run at all.
  const addressedRunIds = useMemo(
    () => addressedPostures.map((addressed) => addressed.runId),
    [addressedPostures],
  );
  const callbackToolCapability = readingAcrossRuns(
    driverCapabilities,
    addressedRunIds,
    CALLBACK_TOOLS_CAPABILITY,
  );
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

  // A refusal that ends the whole session rather than one read reaches the frame's
  // banner instead of a line inside this pane. All three of this pane's reads name
  // the session, so all three are candidates, in the order they are preferred — one
  // handover for one fact, on `preferredBannerClassRefusalAmong`'s reason — these
  // three reads are concurrent, so their order is a preference and not a clock. Each
  // refusal still renders where it happened; escalation is in addition, never instead.
  useRefusalBannerEscalation(
    props.bridgeContext.frameStore,
    preferredBannerClassRefusalAmong([
      refusalOfPhase(snapshot.approvals),
      refusalOfPhase(snapshot.rules),
      driverCapabilities?.readRefusal,
    ]),
  );

  // The pane's acts, reachable from the palette while it is open. Every row is built
  // from the same values the controls below render from AND through the same offer
  // readings, so a row is offered exactly where its control is: `canMutate` fails
  // closed on `undefined`, which is the unresolved role; a card already resolving
  // contributes nothing; and a record whose own resolve refusal settled it
  // contributes nothing either.
  useApprovalCommands({
    pending,
    resolvingApprovalIds: snapshot.resolvingApprovalIds,
    // The same map the card list below receives. Without it the rows read a record's
    // state and nothing else, and a request somebody else answered kept two palette
    // rows the card had already withdrawn.
    resolveRefusalByApprovalId: snapshot.resolveRefusalByApprovalId,
    resolve: (request) => {
      reader.resolve(request);
    },
    goal,
    isMutatingGoal: goalMutation.isMutating,
    clearGoal: goalMutation.clear,
  });

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
          records={partitioned.history}
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
        <ExecutionBoundaryReading phase={snapshot.approvals} addressed={addressedPostures} />
      </section>

      <DaemonHostedToolsSection
        capability={callbackToolCapability}
        readRefusal={driverCapabilities?.readRefusal}
        registry={callbackToolRegistry}
      />
    </div>
  );
}

interface ApprovalsPaneBodyProps {
  readonly bridgeContext: PaneContextOf<"approvals">;
  readonly sessionStore: SessionStore;
}

function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}
