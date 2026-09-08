import { useCallback, useEffect, useMemo } from "react";
import {
  usePushDrivenRead,
  useSessionScopedState,
  type SidebarSectionContext,
} from "../../seats/index.js";
import { useComposingLookup } from "../activity-model.js";
import { useDeadlineWake, useSessionDegraded, useSessionPartition } from "../../store/index.js";
import { Memberships } from "./Memberships.js";
import { deriveMembershipRows } from "./members-model.js";
import {
  membershipEntriesByParticipantId,
  membershipRosterRefusal,
  useMembershipRoster,
} from "./membership-roster.js";
import { usePresenceDetail } from "./presence-detail.js";
import { ageBoundariesOf, rosterRowsFrom } from "./presence-model.js";
import { Roster } from "./Roster.js";
import { terminalControlHolding } from "./terminal-control-holder.js";
import { type CollaborationSessionModels } from "../session-models.js";

/**
 * The three bodies, mounted only once the models exist.
 *
 * A separate component for `ChannelsSection`'s reason: the presence read has to be
 * subscribed to through a hook, and a hook cannot be called conditionally.
 *
 * IT IS ALSO WHERE THE MEMBERSHIP ROWS ARE DERIVED, ONCE. The roster above and the
 * ledger below need the same three facts about the same people — the role, the
 * membership state, and the identifier the four controls are keyed by — and deriving
 * them in each surface would put two answers to one question on one screen the moment
 * the read and the log disagreed. One derivation here, two readers.
 */
export function MembersSectionBody(props: {
  readonly context: SidebarSectionContext;
  readonly models: CollaborationSessionModels;
  readonly selfParticipantId: string | undefined;
}): React.JSX.Element {
  const { context, models, selfParticipantId } = props;
  const { bridge, sessionStore } = context;
  const state = usePushDrivenRead(models.presenceRoster);
  const reading = state.kind === "loaded" ? state.value : undefined;
  const hueAllocator = context.sessionStore.hueAllocator;
  // Subscribed rather than sampled, for `ChannelsSection`'s reason: this section
  // subscribes only to its presence read, so a degraded transition that settles no
  // read would move the flag and re-render nothing.
  const isLastKnown = useSessionDegraded(context.sessionStore);

  // The two sources of a membership fact, and the one merge of them. The store's
  // partition is what the log projected; the roster read is what the wire would say
  // if it had the read. `members-model.ts` owns which one wins where they both speak.
  const participantEntities = useSessionPartition(sessionStore, "participant");
  const membershipRosterReading = useMembershipRoster(bridge, sessionStore.sessionId);
  const membershipEntries = useMemo(
    () => membershipEntriesByParticipantId(membershipRosterReading),
    [membershipRosterReading],
  );
  const membershipRows = useMemo(
    () => deriveMembershipRows(participantEntities, membershipEntries),
    [participantEntities, membershipEntries],
  );
  const roleByParticipantId = useMemo(
    () => new Map(membershipRows.map((row) => [row.participantId, row.role])),
    [membershipRows],
  );
  // A bound lookup rather than the map itself, so the roster's memo compares one
  // stable identity instead of re-deriving a row's chips whenever the section
  // re-renders for a reason that has nothing to do with roles.
  const roleFor = useCallback(
    (participantId: string) => roleByParticipantId.get(participantId),
    [roleByParticipantId],
  );

  // The session's one write lease, kept current by the transition's own event. A mark
  // on a row and a line under the list, never a control: claiming and releasing are
  // the terminal pane's, and this section would name a stale holder for the rest of
  // the visit if it read once and never listened.
  const holderState = usePushDrivenRead(models.terminalControlHolder);
  const holding = useMemo(() => terminalControlHolding(holderState), [holderState]);

  // The device fan-out is asked for ONE row at a time, and only once somebody opens
  // one. Reading it for every row would put an owner-only question about every person
  // in the session behind a panel nobody had looked at.
  //
  // WHICH ROW IS OPEN IS HELD FOR THE SESSION AND NOT FOR THE MOUNT. A participant id
  // names somebody IN a session, so a `useState` cell that survived a re-address handed
  // the fan-out read a pair of "the session arrived at" and "the participant left
  // behind" — and that read is owner-only, so the console asked an authorization
  // question about somebody nobody had opened a row for, in a session they may not even
  // be in. The holder re-seeds during the render that first sees a new session, so no
  // committed frame ever carries the previous one's open row.
  const { value: requestedDetailParticipantId, publish: publishRequestedDetail } =
    useSessionScopedState<string | undefined>(bridge, sessionStore.sessionId, () => undefined);
  // Who this section is drawing right now. `rosterRowsFrom` is total and one-to-one
  // over the read's participants, so the ids the reading carries ARE the rendered
  // roster — and a read that has not answered, or that refused, draws no row at all.
  // `Set<string>` and not the branded element type the read carries: what is asked of
  // it is a held id, which is a plain string, and a set narrowed to the brand would
  // refuse the one question it exists to answer.
  const rosterParticipantIds = useMemo(
    () =>
      new Set<string>(
        (reading?.participants ?? []).map((participant) => participant.participantId),
      ),
    [reading],
  );
  // AND THE REQUEST IS VALIDATED BEFORE ANYTHING SUBSCRIBES. A refresh that drops a
  // participant takes their row with it, and a row that is gone has no control left to
  // close the panel under it — so an unvalidated request left an owner-only read
  // subscribed to the presence stream, re-asking about somebody the session no longer
  // carries, for the rest of the visit. Derived rather than repaired in an effect: the
  // read is opened from the value this render passes down, and a correction one commit
  // later is one commit of asking.
  const openDetailParticipantId =
    requestedDetailParticipantId !== undefined &&
    rosterParticipantIds.has(requestedDetailParticipantId)
      ? requestedDetailParticipantId
      : undefined;
  const detailState = usePresenceDetail(bridge, sessionStore.sessionId, openDetailParticipantId);
  const toggleDetail = useCallback(
    (participantId: string) => {
      // The function form, because two presses settling in one tick both read the
      // value their own render closed over and the second would erase the first.
      publishRequestedDetail((open) => (open === participantId ? undefined : participantId));
    },
    [publishRequestedDetail],
  );
  // And then the request itself is dropped, which the derivation above cannot do for
  // it: a held id the roster stopped carrying would silently re-open the panel if that
  // person came back, reporting a choice nobody made in the meantime as still theirs.
  useEffect(() => {
    if (
      requestedDetailParticipantId !== undefined &&
      !rosterParticipantIds.has(requestedDetailParticipantId)
    ) {
      publishRequestedDetail(undefined);
    }
  }, [publishRequestedDetail, requestedDetailParticipantId, rosterParticipantIds]);

  // Every instant at which some row's rendered age changes, derived from the read's
  // own `lastSeen` stamps. Memoized on the reading rather than on the array, so a
  // re-render that produced an equal list re-arms nothing.
  const ageBoundaries = useMemo(
    () => (reading === undefined ? [] : ageBoundariesOf(reading.participants)),
    [reading],
  );
  // The instant the ages are measured against, and the only one this component has.
  // Never `models.clock.now()` in the render body: that re-read on every pass, armed
  // nothing, and left a row reading "a few seconds ago" for forty-five minutes until
  // something unrelated re-rendered it. The wake-up moves the instant forward at each
  // boundary; the read's own stamp wins while it is the later of the two, so a fresh
  // read never renders ages older than itself.
  const wokeAtMilliseconds = useDeadlineWake(models.clock, ageBoundaries);
  const nowMilliseconds = Math.max(wokeAtMilliseconds, reading?.readAtMilliseconds ?? 0);

  // Subscribed rather than sampled, like the degraded flag above it. Read during
  // render off the registry, a composing mark moved only when something else
  // re-rendered this section — and the something else was the age wake-up, which now
  // fires at the minute a rendered age changes rather than every second. A mark that
  // depends on an unrelated re-render is right by accident.
  const composingChannelFor = useComposingLookup(models.activity);
  // The read's OWN re-open, not a rebuild of the set: a refused subscribe leaves this
  // column terminal for the life of the window, and the roster that refused is the
  // only one that has to be re-opened.
  const reopenRoster = useCallback(() => {
    // ONE CALL, because the seam owns the stream-then-read order now: `refresh` takes
    // the subscription first where it is not held and requests the read either way.
    // A branch here would be a second reading of a decision the read already makes,
    // and the branch this replaced could only be right while both halves agreed.
    models.presenceRoster.refresh("participant-request");
  }, [models]);

  const rows = useMemo(
    () =>
      reading !== undefined
        ? rosterRowsFrom(
            reading.participants,
            // A READ, never an allocation. `admit` would put a participant on the
            // wheel in the order presence happened to return them, and the wheel is
            // allocated in join-log order by the store — so a roster that admitted
            // would hand people colours the timeline beside it disagrees with.
            (participantId) => hueAllocator.assignmentFor(participantId),
            selfParticipantId,
          )
        : [],
    [reading, hueAllocator, selfParticipantId],
  );

  return (
    <>
      <Roster
        state={state}
        rows={rows}
        nowMilliseconds={nowMilliseconds}
        labels={models.labels}
        composingChannelFor={composingChannelFor}
        roleFor={roleFor}
        holding={holding}
        openDetailParticipantId={openDetailParticipantId}
        detailState={detailState}
        onToggleDetail={toggleDetail}
        isLastKnown={isLastKnown}
        onReopen={reopenRoster}
      />
      <Memberships
        context={context}
        rows={membershipRows}
        rosterRefusal={membershipRosterRefusal(membershipRosterReading)}
        isLastKnown={isLastKnown}
      />
    </>
  );
}
