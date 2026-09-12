// NodeId — the daemon-assigned node-identifier brand, in a dependency-free
// leaf module so that BOTH `runtime-node.ts` (the symbol's owner) and
// `repo.ts` can compose it without closing a module cycle.
//
// OWNERSHIP IS UNCHANGED — governs this shape. This file is a STRUCTURAL
// RELOCATION of the declaration block that shipped inside `runtime-node.ts`,
// not a re-declaration: the block below is verbatim, `runtime-node.ts`
// re-exports all three symbols so its public API is exactly what it was, and
// any change to `NodeId`'s shape or cap is still a contract change. Consumers
// keep importing from `@ai-sidekicks/contracts`; no wire contract moves.
//
// WHY A SEPARATE MODULE — the eager three-hop cycle it breaks. the
// `repo.ts` composes `NodeIdSchema` for `RepoAttachRequest.nodeId` and
// `RepoMountReadResponse.nodeId`. Importing it from `runtime-node.ts` would
// close this cycle:
//
//     repo.ts → runtime-node.ts → event.ts → repo.ts
//
//   * `runtime-node.ts` → `event.ts` — VALUE imports (`EVENT_FIELD_MAX_LEN`,
//     `EventEnvelopeVersionSchema`, `CapabilityDetailsSchema`), each read at
//     module scope by one or more schema initializers: the attach request, the
//     roster projection, and the lifecycle / capability payload shapes. THIS
//     EDGE IS GONE as of — the three declarations hoisted to `./event-core.js`
//     and `runtime-node.ts` binds the leaf — so the three-hop cycle is not
//     live today. What survives is the RULE: this module stays import-free so
//     it can never participate in one, and the edge returns the moment
//     anything re-adds an import of `./event.js`.
//   * `event.ts` → `repo.ts` — a VALUE import of
//     `RepoWorkspaceLifecyclePayloadSchema`, read at module scope by all six
//     `SessionEventSchema` arms.
//   * `repo.ts` → `runtime-node.ts` — the edge would have added.
//
// Every edge is an EAGER module-scope Zod initializer, so no evaluation order
// satisfies all three: whichever module the runtime enters first, one of the
// other two reads a binding still in temporal dead zone and throws
// `ReferenceError: Cannot access '<binding>' before initialization`.
// TypeScript compiles module cycles silently, so the failure appears only at
// import time — and because every test loads the barrel, that is a total
// package failure. This module has NO local imports at all (zod only), so it
// can never participate in a cycle, and `repo.ts` therefore imports it
// DIRECTLY rather than through `runtime-node.ts`.
//
// PRECEDENT — `channel-id.ts` is the same shape: a small standalone public
// module under `src/` that stays cycle-free (it reaches its companion type
// through a type-only `import type { ChannelId } from "./session.js"`, which
// erases at runtime).
//
import { z } from "zod";

// --------------------------------------------------------------------------
// NodeId — daemon-assigned opaque string brand (NOT a UUID).
// --------------------------------------------------------------------------
//
// `node_id` is `TEXT NOT NULL, -- daemon-assigned node identifier` in
// `runtime_node_attachments` — deliberately contrasted against `id` /
// `session_id` / `participant_id`, which are `UUID` in the SAME table — and
// `TEXT` in both local SQLite tables. So `NodeId` is a daemon-minted opaque
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
//
// TWO consumers now rely on that annotation, which is why this sentence names
// both: `RuntimeNodeAttachRequestSchema` and its siblings in runtime-node.ts,
// and `RepoAttachRequestSchema` in repo.ts. Dropping the double-T would force
// an `as unknown as z.ZodType<T, T>` bridge onto every one of them, so
// narrowing or retiring any single consumer is NOT licence to weaken it here.
export const NODE_ID_MAX_LEN = 256;
export type NodeId = string & { readonly __brand: "NodeId" };
export const NodeIdSchema: z.ZodType<NodeId, NodeId> = z
  .string()
  .min(1)
  .max(NODE_ID_MAX_LEN)
  .brand<"NodeId">() as unknown as z.ZodType<NodeId, NodeId>;
