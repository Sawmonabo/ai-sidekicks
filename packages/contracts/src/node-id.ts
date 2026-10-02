// The daemon-assigned id of the one machine a daemon runs on, in a leaf module with no local
// imports. Schema modules read `NodeIdSchema` in eager module-scope initializers, and an import
// cycle among those throws `ReferenceError: Cannot access '<binding>' before initialization`
// at import time; a leaf module can never join a cycle, so consumers import it directly.
import { z } from "zod";

// `node_id` is `TEXT NOT NULL` in every table that stores it, so a NodeId is a daemon-minted
// opaque string, not a UUID. It follows the non-UUID branded-scalar pattern of
// `EventCursorSchema` in `session.ts`: `z.string().min(1).max(cap)` with an inline `.brand()`
// cast. The cap guards against pathological lengths in wire input. The `ZodType<NodeId,
// NodeId>` annotation makes the input type resolve to `NodeId` where the schema is composed
// into request schemas, instead of `unknown`.

/** The longest NodeId, in characters. */
export const NODE_ID_MAX_LEN = 256;
/** The opaque, daemon-minted id of one machine's daemon. */
export type NodeId = string & { readonly __brand: "NodeId" };
/** Parses a {@link NodeId}: a non-empty string of at most {@link NODE_ID_MAX_LEN}. */
export const NodeIdSchema: z.ZodType<NodeId, NodeId> = z
  .string()
  .min(1)
  .max(NODE_ID_MAX_LEN)
  .brand<"NodeId">() as unknown as z.ZodType<NodeId, NodeId>;
