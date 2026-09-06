// The daemon seam: what the console may call, what it may subscribe to, and how a
// delivered frame becomes something a surface can read.
//
// ONE SUB-MODULE BECAUSE EVERY MODULE IN IT IS ONE DECISION. The method contract
// names what may be asked, the reply registry binds each method to the shape its
// answer must match, the reply chokepoint is the one place an answer enters the
// console and is parsed against that shape, the stream table names what a
// subscription delivers, and the decoders narrow a delivered frame — a session event
// payload, an entity body member, a reported node state — against the schema the
// corpus registers.
// Split across the bridge's top level they read as unrelated files; together they
// are the single place that knows the wire, which is the property every family above
// depends on. The roles are listed rather than counted: a family lands a module here
// in a diff that never touches this header, and a cardinal is what it would forget.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule this follows. `bridge/index.ts` stays the one door the rest of the console
// comes through and re-exports from the module that DECLARES each name, because
// `console-no-barrel-chain` fails a forward through this file. What this door is for
// is the bridge's OWN modules: a fixture door or a stream projection binds to the
// daemon seam as a set rather than to the file layout underneath it.
//
// WHAT IS PUBLISHED IS WHAT A SIBLING TAKES, and nothing held in reserve. A name
// whose only reader is outside this family leaves through `bridge/index.ts` and is
// deliberately absent here: a specifier no sibling reaches is a dead export the
// barrel census fails, and adding one "for symmetry" is how a door stops describing
// the tree.

export { CONSOLE_DAEMON_METHODS, daemonMethodBindingFor } from "./daemon-reply-registry.js";

export {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  runQueueStreamStateFor,
  runStateForTransitionKind,
  runStateStreamArmFor,
  sessionEventStreamFor,
  subscriptionDeliversEventKind,
  type RunStateStreamKind,
} from "./session-event-streams.js";
