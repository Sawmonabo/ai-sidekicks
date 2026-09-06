// The run and queue subscriptions, and what one delivered beat becomes.
//
// WHAT PUTS A MODULE HERE. A module that reads or projects a frame delivered by a
// `run.*` subscription: which arm a beat travels on, the parts every arm shares, and
// where the queue ROW a queue beat projects comes from. The stream NAMES themselves
// are the daemon seam's, next door — naming a subscription is a different act from
// projecting what it delivers, and the fixture routes by the name before any
// projection runs.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/fixture/index.ts` re-exports from the declaring module, never through here.

export { RUN_QUEUE_ROW_READ } from "./queue-row-source.js";

export { projectRunStreamDelivery } from "./run-stream-projection.js";
