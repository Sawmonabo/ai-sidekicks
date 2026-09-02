// The sidebar's members section: the presence roster's mount.
//
// It resolves this session's models from the family's holder, subscribes to the
// presence read, orders the rows against the session's hue wheel, and hands
// `Roster` plain values. Ordering happens here rather than inside the roster so the
// roster stays a pure render and the ordering rule stays drivable on its own.
//
// THE SECTION RENDERS THREE BODIES, IN THE ORDER A PERSON ASKS THE QUESTIONS. The
// roster answers who is here right now; the membership ledger below it answers on
// what terms they are here at all, and carries the four controls that change those
// terms; the sent-invite ledger inside it answers who has been asked and has not
// arrived. Each reads its own source — presence from the wire, memberships from
// the session's own projection, invitations from the growth port — so a body that
// cannot be read is one absence and not three.

import { useMemo } from "react";

import type { SidebarSectionContext } from "../workspace/seats/index.js";
import { Memberships } from "./Memberships.js";
import { usePushDrivenRead } from "./push-driven-read.js";
import { rosterRowsFrom } from "./presence-model.js";
import { Roster } from "./Roster.js";
import type { CollaborationSessionModelHolder } from "./session-models.js";

export interface MembersSectionProps {
  readonly context: SidebarSectionContext;
  readonly holder: CollaborationSessionModelHolder;
  /**
   * The reader's own participant id, when the mount knows it.
   *
   * Marked rather than moved: the reader's row stays where their presence state puts
   * it, because a roster that hoisted one row would stop being ordered by the thing
   * its ordering claims to mean.
   */
  readonly selfParticipantId?: string | undefined;
}

export function MembersSection(props: MembersSectionProps): React.JSX.Element {
  const { context, holder, selfParticipantId } = props;
  const models = useMemo(
    () => holder.modelsFor(context.bridge, context.sessionStore),
    [holder, context.bridge, context.sessionStore],
  );
  const state = usePushDrivenRead(models.presenceRoster);
  const hueAllocator = context.sessionStore.hueAllocator;

  const rows = useMemo(
    () =>
      state.kind === "loaded"
        ? rosterRowsFrom(
            state.value,
            // A READ, never an allocation. `admit` would put a participant on the
            // wheel in the order presence happened to return them, and the wheel is
            // allocated in join-log order by the store — so a roster that admitted
            // would hand people colours the timeline beside it disagrees with.
            (participantId) => hueAllocator.assignmentFor(participantId),
            selfParticipantId,
          )
        : [],
    [state, hueAllocator, selfParticipantId],
  );

  return (
    <>
      <Roster
        state={state}
        rows={rows}
        // Sampled once per read rather than per frame: the stamps are relative to
        // when the console last heard, and re-reading the clock on every render
        // would arm nothing but would still make two rows in one paint disagree.
        nowMilliseconds={models.clock.now()}
        labels={models.labels}
        composingChannelFor={(participantId) => models.activity.composingChannelFor(participantId)}
        isLastKnown={context.sessionStore.snapshot().degradedCause !== undefined}
      />
      <Memberships context={context} />
    </>
  );
}
