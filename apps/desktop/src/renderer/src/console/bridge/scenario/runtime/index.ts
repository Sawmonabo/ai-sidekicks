// The vocabulary a console scenario is written in, and the machinery that plays one.
//
// WHAT PUTS A MODULE HERE. The scenario shape and its beats, the engine that walks
// one against a frozen clock, the envelope a beat is delivered in, and the settlement
// a scripted reply takes. All of them are about playing a scenario; none of them IS
// one.
//
// WHY IT IS A SUBDIRECTORY. Its parent, `scenario/`, holds the INSTANCES — the seat
// board in `corpus.ts` and the family subdirectories. Keeping the two apart is what
// lets a family add its scenario without touching the engine, and lets the engine
// change without a merge conflict in every family branch at once.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR. `bridge/index.ts` re-exports from the
// declaring module, never through here.
//
// THE MANIFEST AND THE SELECTION ARE NOT HERE. Both read the corpus, and `runtime/`
// imports nothing from the directory above it; `scenario/index.ts` states the rule.

export type { ConsoleScenario, ScenarioBeat } from "./vocabulary.js";

// The reply table, from the module that DECLARES it rather than through the shape that
// composes it. The family subdirectories of `scenario/` write a `readonly
// ScenarioReply[]` and name no other member of a scenario, so the seam they take is the
// reply's and not the shape's.
export type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";

export { ScenarioEngine } from "./engine.js";

export { composeScenarioEventEnvelope } from "@renderer/services/daemon/event-envelope.fixture.js";

export {
  SCRIPTED_REPLY_REFUSAL_CODES,
  SCRIPT_ABSENT_REFUSAL_CODE,
  settleScriptedReply,
} from "@renderer/services/daemon/scripted-reply.fixture.js";
