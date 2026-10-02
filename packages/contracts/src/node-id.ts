// The daemon-assigned id of the one machine a daemon runs on. A leaf module with no local imports:
// schema modules read `NodeIdSchema` in eager module-scope initializers, and an import cycle among
// those throws at import time.
import { z } from "zod";

// A NodeId is a daemon-minted opaque string, not a UUID. The `ZodType<NodeId, NodeId>` annotation
// keeps the input type `NodeId`, not `unknown`, where the schema is composed into a request.

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
