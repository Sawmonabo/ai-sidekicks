// Internal helpers for the @ai-sidekicks/contracts package — NOT re-exported
// from `src/index.ts`. Consumers must go through the public surface.
//
// `internal/` (no leading underscore) matches the convention established by
// `packages/crypto-paseto/src/internal/v4-local-deterministic.ts`.
import { z } from "zod";

/**
 * Bridges Zod v4 `$ZodBranded` single-T output to the double-T `ZodType<T, T>`
 * shape required for Standard Schema V1 input inference in tRPC v11 request
 * schemas (per ADR-014). The `as unknown as` cast is load-bearing; the runtime
 * `.brand(brandName)` call preserves Zod's internal brand metadata.
 *
 * Used for the UUID-based branded IDs declared in `session.ts` and `invites.ts`
 * (SessionId, ParticipantId, MembershipId, ChannelId, InviteId). Non-UUID
 * branded scalars (e.g. `EventCursor`, whose internal structure is owned by
 * Plan-006 — see session.ts `EventCursorSchema`) compose `.brand()` inline and
 * apply the same cast pattern at the callsite.
 *
 * The explicit `z.ZodType<T, T>` return type is required because the contracts
 * package compiles with `isolatedDeclarations: true` — exported declarations
 * cannot rely on inferred return types.
 */
export function brandedUuidIdSchema<T extends string>(brandName: string): z.ZodType<T, T> {
  return z.string().uuid().brand(brandName) as unknown as z.ZodType<T, T>;
}
