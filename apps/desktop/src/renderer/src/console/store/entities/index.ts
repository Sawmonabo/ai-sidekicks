// The entities sub-module's door.
//
// A SUB-MODULE door and not a second family door: it publishes to `store/` only,
// it is reached by deep intra-family specifiers, and `store/index.ts` re-exports
// every one of these symbols from the module that DECLARES it rather than through
// this file (`console-no-barrel-chain`).
//
// It exists because two sibling sub-modules read this one: `session/` takes the
// entity contract, the partition merge, and the projection runner, and `read/`
// takes the event shape. What is published is exactly what those two take —
// `entity-projector-registry.ts` is deliberately absent, because its only reader is
// the family door, which reaches it directly.

export {
  emptyPartitions,
  type ConsoleEntity,
  type ConsoleEntityKind,
  type ConsoleEntityRef,
  type ConsoleSessionEvent,
  type EntityProjectorRegistry,
} from "./entities.js";
export { mergeUpsert, type SessionPartitions } from "./entity-partitions.js";
export { EntityProjectionRunner } from "./entity-projection.js";
