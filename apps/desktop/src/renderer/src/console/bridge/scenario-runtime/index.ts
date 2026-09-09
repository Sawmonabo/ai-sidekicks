// The vocabulary a console scenario is written in, and the machinery that plays one.
//
// WHAT PUTS A MODULE HERE. The scenario shape and its beats, the engine that walks
// one against a frozen clock, the envelope a beat is delivered in, the manifest that
// checks every scenario against the growth slate, the selection a window resolves at
// mount, and the settlement a scripted reply takes. All of them are about playing a
// scenario; none of them IS one.
//
// WHY IT IS NOT `scenarios/`. That directory holds the INSTANCES — the seat board six
// family branches each add one line to. Keeping the two apart is what lets a family
// add its scenario without touching the engine, and lets the engine change without a
// merge conflict in every family branch at once.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/index.ts` re-exports from the declaring module, never through here.
//
// AND THE MANIFEST AND THE SELECTION ARE DELIBERATELY NOT PUBLISHED HERE. A door is
// an edge to every module it re-exports from, so publishing `scenario-manifest.ts`
// would give every reader of this door an edge into the fixture — which imports the
// bridge contract, which imports the engine beside this line. Measured: it closes
// four cycles `no-circular` fails. Both are reached by their own deep specifier, the
// same remedy `fixture/call-plane/refusal.ts` records for the same shape.

export type { ConsoleScenario, ScenarioBeat } from "./scenario.js";

// The reply table, from the module that DECLARES it rather than through the shape that
// composes it — the same rule the reading families below are published under. Its
// siblings under `scenarios/` write a `readonly ScenarioReply[]` and name no other
// member of a scenario, so the seam they take is the reply's and not the shape's.
export type { ScenarioReply } from "./scenario-reply.js";

// The tick-scheduled reading families, from the modules that DECLARE them rather than
// through `scenario.ts`, which imports them to compose the shape and re-exports none:
// a door names the declaring module, which is what keeps one symbol reachable by one
// path rather than by a chain a rename can silently reroute.
export type {
  ScenarioActivityFrame,
  ScenarioRuntimeNodeRosterFrame,
  ScenarioShellStatusFrame,
  ScenarioTransportOutage,
} from "./scenario-frames.js";

export type {
  ScenarioPendingInviteAttemptFrame,
  ScenarioPendingInviteFrame,
  ScenarioPendingInviteRefusedFrame,
} from "./scenario-pending-invites.js";

export { ScenarioEngine } from "./scenario-engine.js";

// The `incident` class's two seams, from the modules that DECLARE them. The pair lives
// in the `incident/` sub-module — a directory grouping and not a sub-module DOOR, since
// no sibling of `incident/` inside this directory reads it and the family door has to
// re-export from the declaring module regardless. `scenarios/` holds the instances and
// takes exactly these: the recorded shape its frames are written in, and the composer
// that turns a recording into a scenario. The RECORDER and the PLAYER stay off this door
// on the rule above — a door publishes what a sibling takes, and their only readers are
// inside `incident/` and its own suites.
export type { IncidentRecording, IncidentWireDelta } from "./incident/incident-recording.js";

export { composeIncidentScenario } from "./incident/incident-replay.js";

export { composeScenarioEventEnvelope } from "./scenario-envelope.js";

// Reading one STRING or NUMBER member off a value nothing typed. Published because two
// siblings take them from opposite sides of the scripted-reply seam this directory owns
// — `fixture/` derives what a scenario declares with them, `scenarios/` reads the
// request a computed reply is handed — and the seam, not either caller, is what they
// are about. Two primitives because a request key is written in two: a definition id is
// a string and a version ordinal is a number, and a reply keyed on both reads both. The
// container read underneath them stays private: every reader outside that module asks
// for a typed value, so the untyped read has no caller of its own to leave for.
export { readUnknownNumberMember, readUnknownStringMember } from "./unknown-member.js";

export {
  SCRIPTED_REPLY_REFUSAL_CODES,
  SCRIPT_ABSENT_REFUSAL_CODE,
  settleScriptedReply,
  type ScriptedReplyRefusalCode,
} from "./scripted-reply.js";
