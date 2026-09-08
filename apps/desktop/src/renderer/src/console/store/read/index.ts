// The read sub-module's door.
//
// A SUB-MODULE door and not a second family door: it publishes to `store/` only,
// it is reached by deep intra-family specifiers, and `store/index.ts` re-exports
// every one of these symbols from the module that DECLARES it rather than through
// this file (`console-no-barrel-chain`).
//
// It exists because `act/` reads this sub-module: the act controller composes the
// refresh scheduler, the trigger surface, the generation latch, and the read round.
//
// WHAT IS DELIBERATELY OFF IT, AND WHY THE TWO SESSION-SIDE READERS GO DEEP.
// `apply-queue.ts` and `refresh-scheduler.ts` are also read from `session/`, by
// `open-session-entry.ts` and `session-store-registry.ts`, and those two take their
// names by their own specifiers rather than through this door. Routing them here
// would close a cycle `no-circular` fails: this door is an edge to
// `read-triggers.ts`, which reads `session/index.js`, which publishes
// `session-hooks.ts`, which reads `session-store-registry.ts` — so a fifth edge
// back to this door completes the ring. The deep edge is the remedy AGENTS.md
// §Module shape names for exactly this shape, and it is why `ApplyQueue` — whose
// only sibling reader is one of those two — is not published here at all.

export { GenerationLatch } from "./generation-latch.js";
export type { ReadRound } from "./read-cancellation.js";
export type { ReadTriggerTarget } from "./read-triggers.js";
export { RefreshScheduler, type RefreshReason } from "./refresh-scheduler.js";
export { SessionRefreshTriggers } from "./refresh-triggers.js";
