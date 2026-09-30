// NodeId — the daemon-assigned id of the one machine a daemon runs on, in a
// dependency-free leaf module.
//
// WHY A SEPARATE MODULE — every schema module that composes `NodeIdSchema`
// (`repo.ts`, `event.ts`) reads it in an EAGER module-scope Zod initializer. A
// module cycle among such initializers throws `ReferenceError: Cannot access
// '<binding>' before initialization` at import time, and TypeScript compiles
// the cycle silently; because every test loads the barrel, that is a total
// package failure. This module has NO local imports (zod only), so it can never
// take part in a cycle, and its consumers import it directly; the barrel
// re-exports it.
//
import { z } from "zod";

// --------------------------------------------------------------------------
// NodeId — daemon-assigned opaque string brand (NOT a UUID).
// --------------------------------------------------------------------------
//
// `node_id` is `TEXT NOT NULL` in every table that stores it, in the daemon's
// SQLite and the control plane's Postgres alike. So `NodeId` is a daemon-minted opaque
// scalar, NOT a server-minted UUID: we mirror `SessionId`'s brand SHAPE but
// deliberately depart from its UUID parser, using the non-UUID branded-scalar
// idiom from `session.ts`'s `EventCursorSchema` (z.string().min(1).max(cap)
// + inline `.brand()` cast) instead of the `brandedUuidIdSchema` helper.
//
// The `.max(NODE_ID_MAX_LEN)` cap is defense-in-depth against pathological
// lengths (mirrors `EVENT_CURSOR_MAX_LEN` in session.ts — the wire/IPC trust
// boundary admits cross-node input we cannot length-trust on producer faith
// alone). The `z.ZodType<NodeId, NodeId>` double-T annotation (not single-T)
// is required because `NodeIdSchema` composes into request schemas whose
// Standard-Schema-V1 input inference must resolve to `NodeId` and not
// `unknown` (same rationale as `EventCursorSchema`;./internal/branded.ts).
export const NODE_ID_MAX_LEN = 256;
export type NodeId = string & { readonly __brand: "NodeId" };
export const NodeIdSchema: z.ZodType<NodeId, NodeId> = z
  .string()
  .min(1)
  .max(NODE_ID_MAX_LEN)
  .brand<"NodeId">() as unknown as z.ZodType<NodeId, NodeId>;
