// The machines this session's repositories could be attached on.
//
// SCRIPTED BECAUSE THE ATTACH DIALOG READS IT. `repo.attach` names the node that holds
// the path, and the only way a participant can name one is by picking it off
// `runtimenode.roster` — so a repos scenario with no roster leaves the picker showing a
// refusal and the dialog unreachable past its first field.
//
// TWO MACHINES, WHICH IS WHAT MAKES THE CHOICE REAL. One node is pre-picked by the form
// (there is no decision to make), so a one-node roster would leave the picker's own
// arms — the selection, the incomplete verdict that asks for a node, and the offline
// row's disclosure — unreachable from the fixture. The second machine is OFFLINE on the
// slot axis and still offered, which is the picker's whole posture: whether a node can
// attach a given path is a question only that node can answer, so every node the roster
// names is offered and one that cannot serve the attach refuses it with a typed code.
//
// THE ROSTER IS CONSTANT ACROSS THE SCENARIO'S CLOCK, unlike the collaboration one. That
// script exists to move two health axes against each other over time; this one exists so
// a dialog opened at any tick has nodes in it, and a roster that was empty before some
// tick would make the dialog's emptiness a function of when it was opened.

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
} from "@ai-sidekicks/contracts";

import type { ScenarioRuntimeNodeRosterFrame } from "../scenario-runtime/index.js";

import { secondsBeforeStart } from "./repos-beats.js";
import { NODE_ID, PARTICIPANT_YOU } from "./repos-fixture-data.js";

/** The second machine, offered and offline. Not a UUID: `NodeId` is a bounded string. */
const BUILD_NODE_ID = "node-build-box" as NodeId;

/** This scenario's own node, branded where the roster wants it. */
const REPOS_NODE_ID = NODE_ID as NodeId;

/** Who owns both machines. One participant in this scenario, so one owner. */
const ROSTER_OWNER = PARTICIPANT_YOU as ParticipantId;

/**
 * The MAJOR.MINOR wire-contract version each daemon reported at attach.
 *
 * Branded at the declaration, and deliberately NOT a release version: the brand rejects
 * a patch segment outright, and the read-only verdict is derived from this against the
 * session floor.
 */
const CLIENT_VERSION = "1.4" as EventEnvelopeVersion;

const REPOS_NODES: readonly RuntimeNodeRosterEntry[] = [
  {
    nodeId: REPOS_NODE_ID,
    participantId: ROSTER_OWNER,
    state: "online",
    healthState: "online",
    lastHeartbeatAt: secondsBeforeStart(4),
    readOnly: false,
    capabilities: { terminal: { available: true } },
    clientVersion: CLIENT_VERSION,
    attachedAt: secondsBeforeStart(3 * 60 * 60),
  },
  {
    nodeId: BUILD_NODE_ID,
    participantId: ROSTER_OWNER,
    // THE TWO AXES DISAGREE HERE ON PURPOSE. The slot says the machine has gone and the
    // sweep's last reading still says it was degraded rather than absent; the picker
    // discloses both rather than reconciling them, which is what the wire does too.
    state: "offline",
    healthState: "degraded",
    lastHeartbeatAt: secondsBeforeStart(31 * 60),
    readOnly: false,
    capabilities: { terminal: { available: true } },
    clientVersion: CLIENT_VERSION,
    attachedAt: secondsBeforeStart(5 * 60 * 60),
  },
];

/** One frame, from tick zero, so the dialog has nodes whenever it is opened. */
export const REPOS_RUNTIME_NODE_ROSTER: readonly ScenarioRuntimeNodeRosterFrame[] = [
  { atMs: 0, nodes: REPOS_NODES },
];
