// The runtime-node seam: one registered control-plane read, one registered daemon
// subscription, and the two bridges' arms for both.
//
// WHAT PUTS A MODULE HERE. It folds ONE wire pair — `runtimenode.roster` and the
// `runtime_node.*` presence names — into the outcomes a surface renders. Neither is
// growth: both are registered, so `growth-port/` refuses neither and no slate row is
// owed. It is not `daemon/` either: that sub-module is the seam every call and every
// subscription passes through — the method contract, the reply chokepoint, the stream
// table, the frame decoders — and this is one feed folded on top of it, on the rule
// that a feed takes a directory named for the wire it folds.
//
// TWO MODULES, ONE VOCABULARY. `runtime-node-roster.ts` holds the names, the outcome
// types and the one refusal constructor both arms stamp their `origin` through;
// `runtime-node-roster-transport.ts` holds everything that touches a real transport.
// Neither arm can invent a name the other does not know. The fixture's arm is not here
// at all — it is `fixture/fixture-runtime-node-roster.ts`, on that directory's own rule
// that a module which makes the fixture ANSWER something belongs beside the fixture —
// which is why nothing under this directory imports `scenario-runtime/`.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. It publishes what a SIBLING takes: the bridge contract types the pair on
// `ConsoleBridge`, the live bridge binds the transport arms, and the fixture binds the
// scenario read. Nothing here has a reader outside `bridge/`, so nothing here is on
// `bridge/index.ts` at all.

// WHAT A SIBLING TAKES AND NOTHING ELSE: the two seam types the bridge contract puts
// on `ConsoleBridge`, the two live arms, and the three names the fixture's own roster
// arm builds its answer out of — the outcome union it returns, the refused arm it
// narrows to, and the constructor that stamps this seam's `origin` on both. The seam's
// spelled procedure name, its event census and its wire refusal-code tuple are read
// only by the suites beside them, and a suite is not a reader a door line survives —
// `barrel-census` fails such a specifier as reached only by a test, and knip reports it
// besides.
export {
  runtimeNodeRefusal,
  type RuntimeNodePresenceSubscribe,
  type RuntimeNodeRefused,
  type RuntimeNodeRosterOutcome,
  type RuntimeNodeRosterRead,
} from "./runtime-node-roster.js";

export {
  readRuntimeNodeRosterOverControlPlane,
  subscribeRuntimeNodePresence,
} from "./runtime-node-roster-transport.js";
