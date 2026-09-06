import { useMemo } from "react";
import { usePushDrivenRead, type SidebarSectionContext } from "../../seats/index.js";
import { useComposingLookup } from "../activity-model.js";
import { useDeadlineWake, useSessionDegraded } from "../../store/index.js";
import { Memberships } from "./Memberships.js";
import { ageBoundariesOf, rosterRowsFrom } from "./presence-model.js";
import { Roster } from "./Roster.js";
import { type CollaborationSessionModels } from "../session-models.js";

/**
 * The three bodies, mounted only once the models exist.
 *
 * A separate component for `ChannelsSection`'s reason: the presence read has to be
 * subscribed to through a hook, and a hook cannot be called conditionally.
 */
export function MembersSectionBody(props: {
  readonly context: SidebarSectionContext;
  readonly models: CollaborationSessionModels;
  readonly selfParticipantId: string | undefined;
}): React.JSX.Element {
  const { context, models, selfParticipantId } = props;
  const state = usePushDrivenRead(models.presenceRoster);
  const reading = state.kind === "loaded" ? state.value : undefined;
  const hueAllocator = context.sessionStore.hueAllocator;
  // Subscribed rather than sampled, for `ChannelsSection`'s reason: this section
  // subscribes only to its presence read, so a degraded transition that settles no
  // read would move the flag and re-render nothing.
  const isLastKnown = useSessionDegraded(context.sessionStore);

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
        isLastKnown={isLastKnown}
      />
      <Memberships context={context} />
    </>
  );
}
