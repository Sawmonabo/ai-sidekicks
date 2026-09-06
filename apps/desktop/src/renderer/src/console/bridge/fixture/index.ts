// The fixture bridge: a real `SidekicksBridge` backed by a scripted scenario.
//
// WHAT PUTS A MODULE HERE. A module that exists so the fixture can ANSWER — the
// bridge object itself, its two doors (the call door and the subscription door), the
// refusal vocabulary both raise, the growth port that decides which operation is
// served, and the answer builders that port leans on, each composing one plane's
// reply out of the scenario in play: the base state a session opens with, what the
// node has, the attention projection, and a scripted settlement. They are named
// rather than counted, because a plane the fixture learns to answer adds one here in
// a diff that never reads this header. `fixture-refusal.ts` is separate from the
// bridge on purpose and must not be folded back in: both doors raise it and the
// bridge composes them, so a vocabulary declared in the bridge would close an import
// cycle. The scripted pane view host is here on the same reading: what it decides is
// what the fixture can honestly say about a pane, which is an answer and not a shape
// the wire carries.
//
// ONE EDGE INTO THIS DIRECTORY STAYS DEEP, and this is where it says so.
// `console-bridge.ts` names `ScriptedPaneViewHost` on the contract and reaches it by
// its own specifier: a door is an edge to every module it re-exports, `fixture-bridge.ts`
// imports that contract, and taking this door from the contract would close the cycle
// `no-circular` fails. The deep specifier is the remedy for that one edge, never a
// shim and never a wider door.
//
// WHAT IS NOT HERE: the scenario itself. `scenario-runtime/` holds the vocabulary a
// scenario is written in and the engine that plays one, and `scenarios/` holds the
// instances. This directory holds only the side that answers.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/index.ts` publishes `createFixtureBridge` from the module that
// DECLARES it, because `console-no-barrel-chain` fails a forward through here.

export { createFixtureBridge } from "./fixture-bridge.js";

export { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";

export { BASE_STATE_CURSOR } from "./fixture-session-snapshot.js";
