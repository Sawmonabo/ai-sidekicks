// The scaffolding both `MixedVersionStatus` verdict suites build their entry from.
//
// The view splits along the two independent axes it renders: WHAT ACCESS the server
// resolved for the node (`MixedVersionStatus.verdict.test.tsx`) and WHICH ARM a
// refused write lands on (`MixedVersionStatus.refusal.test.tsx`). Both mount the same
// component off the same roster projection, so the builder and the typed refusal
// envelope have one home — a second copy is the drift this file exists to stop: a
// roster entry gaining a required member has to move once.
//
// THIS VIEW IS PROPS-ONLY. It touches no bridge arm, so there is no
// `window.sidekicks` mock here, no global to install, and no `afterEach` deleting
// one — unlike the sibling `NodeRoster` / `AttachFlow` scaffolding.

import { VERSION_FLOOR_EXCEEDED_CODE } from "@ai-sidekicks/contracts";
import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
  VersionFloorExceededError,
} from "@ai-sidekicks/contracts";

// Branded id fixtures — the `"<uuid>" as NodeId` form mirrors the shipped renderer +
// SDK precedent.
export const ATTACHED_NODE_ID = "01970000-0000-7000-8000-0000000000c1" as NodeId;
export const BELOW_FLOOR_CLIENT_VERSION = "1.0" as EventEnvelopeVersion;

// Not exported: no case names the at-floor version or the owning participant
// directly — both reach the assertions only through the builder below, which is
// what makes them the DEFAULT rather than a fixture a case picks up.
const AT_FLOOR_CLIENT_VERSION = "2.0" as EventEnvelopeVersion;
const OWNING_PARTICIPANT_ID = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;

/**
 * A roster entry as the control-plane `readRoster` projection emits it.
 *
 * The default is the at-floor, read-write, healthy case; each test overrides only the
 * axis it is pinning, so an unrelated field drifting cannot silently change what a
 * case proves.
 */
export function buildRosterEntry(
  overrides: Partial<RuntimeNodeRosterEntry> = {},
): RuntimeNodeRosterEntry {
  return {
    nodeId: ATTACHED_NODE_ID,
    participantId: OWNING_PARTICIPANT_ID,
    state: "online",
    healthState: "online",
    lastHeartbeatAt: "2026-06-10T10:00:00.000Z",
    readOnly: false,
    capabilities: { "shell.exec": true },
    clientVersion: AT_FLOOR_CLIENT_VERSION,
    attachedAt: "2026-06-10T09:59:00.000Z",
    ...overrides,
  };
}

// The real typed refusal envelope, built from the shipped contract type and the
// shipped code constant — not a hand-rolled literal. If the wire code moves, this
// fixture moves with it and the recognizer test still pins the real seam.
export const FLOOR_REFUSAL_MESSAGE = "client version 1.0 is below the session floor 2.0";
export const FLOOR_REFUSAL_ENVELOPE: VersionFloorExceededError = {
  code: VERSION_FLOOR_EXCEEDED_CODE,
  message: FLOOR_REFUSAL_MESSAGE,
  details: {
    attemptedVersion: "1.0",
    acceptedRange: { min: "2.0", max: "2.0" },
  },
};
