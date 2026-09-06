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
// same remedy `fixture-refusal.ts` records for the same shape.

export type {
  ConsoleScenario,
  ScenarioBeat,
  ScenarioReply,
  ScenarioRuntimeNodeRosterFrame,
  ScenarioShellStatusFrame,
} from "./scenario.js";

export { ScenarioEngine } from "./scenario-engine.js";

export { composeScenarioEventEnvelope } from "./scenario-envelope.js";

// Reading one STRING member off a value nothing typed. Published because two siblings
// take it from opposite sides of the scripted-reply seam this directory owns —
// `fixture/` derives what a scenario declares with it, `scenarios/` reads the request a
// computed reply is handed — and the seam, not either caller, is what it is about. The
// container read underneath it stays private: every reader outside this module asks for
// an identifier, so the untyped read has no caller of its own to leave for.
export { readUnknownStringMember } from "./unknown-member.js";

export {
  SCRIPTED_REPLY_REFUSAL_CODES,
  SCRIPT_ABSENT_REFUSAL_CODE,
  settleScriptedReply,
  type ScriptedReplyRefusalCode,
} from "./scripted-reply.js";
