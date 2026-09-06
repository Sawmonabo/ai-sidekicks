// What every roster case is handed before it is about anything.
//
// One module rather than a copy per suite, because the two suites beside it drive the
// SAME component from opposite ends — one the read's states and absences, the other the
// marks a loaded row carries — and a second `renderRoster` would let the two drift into
// rendering different components under one name.
//
// EVERY VALUE HERE IS MODULE-LEVEL AND STABLE, and that is load-bearing rather than
// tidy: the memo cases count the roster's own work across a re-render with the same
// props, and a lookup or handler rebuilt per render would make "the same props" a lie
// and let those cases pass over a memo that never hit.

import type { MembershipRole, PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";

import { frozenStartMilliseconds } from "../../core/frozen-instant.test-support.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import type { ChannelActivityLabels } from "../activity-model.js";
import { rosterRowsFrom, type PresenceReading, type RosterRow } from "./presence-model.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import type { PresenceDetailReading } from "./presence-detail.js";
import { Roster } from "./Roster.js";
import type { TerminalControlHolding } from "./terminal-control-holder.js";

export const NOW_MILLISECONDS: number = frozenStartMilliseconds();

/** A stable no-op re-open. Fresh per render, it would defeat the memo the cases below drive. */
export const NO_REOPEN: () => void = (): void => undefined;

/**
 * The four props every case supplies and few of them are about.
 *
 * Module-level and stable for the memo cases' sake: a fresh lookup or handler each
 * render would make the "same props" pass re-render, and the two cases that count the
 * roster's own work would pass over a memo that never hit.
 */
export const NO_ROLES: (participantId: string) => MembershipRole | undefined = () => undefined;
export const NO_DETAIL_TOGGLE: (participantId: string) => void = () => undefined;
export const UNREAD_HOLDING: TerminalControlHolding = { kind: "unread" };
export const READ_PROPS: {
  readonly roleFor: (participantId: string) => MembershipRole | undefined;
  readonly holding: TerminalControlHolding;
  readonly openDetailParticipantId: string | undefined;
  readonly detailReading: PresenceDetailReading | undefined;
  readonly onToggleDetail: (participantId: string) => void;
} = {
  roleFor: NO_ROLES,
  holding: UNREAD_HOLDING,
  openDetailParticipantId: undefined,
  detailReading: undefined,
  onToggleDetail: NO_DETAIL_TOGGLE,
};

export const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId.replace("participant-", ""),
  runLabel: (runId) => runId,
};

export function participant(
  participantId: string,
  state: PresenceReadResponseParticipant["state"],
): PresenceReadResponseParticipant {
  return {
    participantId: participantId as PresenceReadResponseParticipant["participantId"],
    state,
    lastSeen: "2026-01-01T09:59:30.000Z",
  };
}

export function renderRoster(
  participants: readonly PresenceReadResponseParticipant[],
  overrides?: {
    readonly allocator?: ParticipantHueAllocator;
    readonly selfParticipantId?: string;
    readonly composingChannelFor?: (participantId: string) => string | undefined;
    readonly isLastKnown?: boolean;
    readonly onReopen?: () => void;
    readonly roleFor?: (participantId: string) => MembershipRole | undefined;
    readonly holding?: TerminalControlHolding;
    readonly openDetailParticipantId?: string;
    readonly detailReading?: PresenceDetailReading;
    readonly onToggleDetail?: (participantId: string) => void;
  },
): ReturnType<typeof render> {
  const allocator = overrides?.allocator ?? new ParticipantHueAllocator();
  const rows: readonly RosterRow[] = rosterRowsFrom(
    participants,
    (participantId) => allocator.assignmentFor(participantId),
    overrides?.selfParticipantId,
  );
  const state: PushDrivenReadState<PresenceReading> = {
    kind: "loaded",
    value: { participants, readAtMilliseconds: NOW_MILLISECONDS },
  };
  return render(
    <Roster
      state={state}
      rows={rows}
      nowMilliseconds={NOW_MILLISECONDS}
      labels={LABELS}
      composingChannelFor={overrides?.composingChannelFor ?? (() => undefined)}
      roleFor={overrides?.roleFor ?? NO_ROLES}
      holding={overrides?.holding ?? UNREAD_HOLDING}
      openDetailParticipantId={overrides?.openDetailParticipantId}
      detailReading={overrides?.detailReading}
      onToggleDetail={overrides?.onToggleDetail ?? NO_DETAIL_TOGGLE}
      isLastKnown={overrides?.isLastKnown ?? false}
      onReopen={overrides?.onReopen ?? (() => undefined)}
    />,
  );
}
