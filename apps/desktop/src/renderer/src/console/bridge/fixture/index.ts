// The fixture bridge: a real `SidekicksBridge` backed by a scripted scenario.
//
// WHAT PUTS A MODULE HERE. A module that exists so the fixture can ANSWER — the
// bridge object itself, its two doors (the call door and the subscription door), the
// refusal vocabulary both raise, the served set that decides WHICH growth operation
// is answered, the growth port that composes each answer, and the answer builders
// that port leans on, each composing one plane's reply out of the scenario in play:
// the base state a session opens with, what the node has, the runtime-node roster the
// scenario's frames report, the attention projection, and a scripted settlement. They
// are named
// rather than counted, because a plane the fixture learns to answer adds one here in
// a diff that never reads this header. `fixture-refusal.ts` is separate from the
// bridge on purpose and must not be folded back in: both doors raise it and the
// bridge composes them, so a vocabulary declared in the bridge would close an import
// cycle.
//
// WHAT IS NOT HERE: the scenario itself. `scenario-runtime/` holds the vocabulary a
// scenario is written in and the engine that plays one, and `scenarios/` holds the
// instances. This directory holds only the side that answers.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/index.ts` publishes `createFixtureBridge` from the module that
// DECLARES it, because `console-no-barrel-chain` fails a forward through here.

export { createFixtureBridge } from "./fixture-bridge.js";

export { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-served-operations.js";

export { BASE_STATE_CURSOR } from "./fixture-session-snapshot.js";
