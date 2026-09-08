// Internal helpers for the @ai-sidekicks/contracts package — NOT re-exported
// from `src/index.ts`. Consumers must go through the public surface.
//
// `internal/` (no leading underscore) matches the convention established by
// `packages/crypto-paseto/src/internal/v4-local-deterministic.ts`.
import { z } from "zod";

/**
 * The RFC 9562 UUID text form, stated ONCE for every branded UUID id in this
 * package. Three alternatives, ALL matched case-insensitively:
 *
 *   1. The general form — [RFC 9562 §4](https://www.rfc-editor.org/rfc/rfc9562#section-4)
 *      8-4-4-4-12 hex with the §4.2 version nibble in `1`-`8` and the §4.1
 *      variant bits `10` (nibble `8`, `9`, `a`, or `b`).
 *   2. The §5.9 Nil UUID, all zeros.
 *   3. The §5.10 Max UUID, all ones.
 *
 * WHY THIS IS NOT `z.string().uuid()`. Zod 4.3.6's versionless `uuid` regex
 * (`node_modules/zod/v4/core/regexes.js`) is, verbatim:
 *
 *   /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
 *
 * Its general alternative spells case-insensitivity out in the character
 * classes, but the two sentinels are EXACT LOWERCASE STRING LITERALS on a
 * regex carrying no `i` flag — and the general alternative cannot rescue them,
 * because its `[1-8]` version nibble rejects the Max UUID's `f`. So
 * `ffffffff-ffff-ffff-ffff-ffffffffffff` parsed and
 * `FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF` did not, which handed two textual
 * spellings of ONE logical UUID two different parse results. RFC 9562 §4 makes
 * UUID hex text case-insensitive ("uppercase or lowercase"), so that split was
 * a validator artifact and never a property of the identifier. (The Nil UUID is
 * all digits, so case was vacuous there — the defect reached exactly the Max
 * UUID, which is the daemon-scope anchoring sentinel.)
 *
 * NO TRANSFORM, DELIBERATELY. This predicate ACCEPTS case-insensitively and
 * normalizes nothing. Canonicalization stays exactly where `uuid-canonical.ts`
 * puts it — explicitly at each Map-key / hash-input boundary — for the reason
 * that file's header gives: branding in this codebase is cast-based (ids are
 * branded by bare `as SessionId` casts at DB-row reads, not by parsing through
 * these schemas), so a schema-level `.toLowerCase()` would not fire on those
 * paths and would leave the case-split bug alive at exactly the boundaries that
 * matter while looking as though it had been fixed.
 */
const RFC_9562_TEXT_FORM =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;

/**
 * The same accept set as `brandedUuidIdSchema`, WITHOUT a brand.
 *
 * For the narrow case of a wire member that is an id by nature but whose brand
 * is another plan's unshipped symbol, so declaring the brand here would be the
 * duplicate source of truth this file exists to prevent — `repo.ts`'s
 * `worktreeId` is the shipped instance, since Plan-010 owns `WorktreeId`.
 * Composing this rather than `z.string().uuid()` is what makes that member's
 * standing claim — the runtime accept set is already identical and only the
 * compile-time brand is absent — true by CONSTRUCTION rather than by
 * coincidence: the owning plan can narrow at its own consumption site with no
 * wire change, because no value's parse result moves when the brand arrives.
 *
 * NOT for a client-minted opaque key that merely happens to be UUID-shaped
 * (`clientIdempotencyKey`): that is not an id awaiting a brand, nothing will
 * ever compare it against a branded id, and holding it to Zod's stricter
 * `.uuid()` costs nothing.
 *
 * The explicit type annotation is required because the contracts package
 * compiles with `isolatedDeclarations: true`.
 */
export const uuidTextFormSchema: z.ZodType<string, string> = z
  .string()
  .regex(RFC_9562_TEXT_FORM, "Invalid UUID: expected an RFC 9562 text form");

/**
 * Bridges Zod v4 `$ZodBranded` single-T output to the double-T `ZodType<T, T>`
 * shape required for Standard Schema V1 input inference in tRPC v11 request
 * schemas (per ADR-014). The `as unknown as` cast is load-bearing; the runtime
 * `.brand(brandName)` call preserves Zod's internal brand metadata.
 *
 * Used for the UUID-based branded IDs declared in `session.ts` and `invites.ts`
 * (SessionId, ParticipantId, MembershipId, ChannelId, InviteId) and for every
 * later family composed through it (RunId, ArtifactId, the repo / worktree /
 * runtime-node ids). Every one of them therefore shares ONE accept set —
 * `RFC_9562_TEXT_FORM` above — so a value that parses as one branded id parses
 * as all of them, and widening or narrowing the encoding is a single edit here
 * rather than a sweep. Non-UUID branded scalars (e.g. `EventCursor`, whose
 * internal structure is owned by Plan-006 — see session.ts `EventCursorSchema`)
 * compose `.brand()` inline and apply the same cast pattern at the callsite.
 *
 * The refusal message keeps the word "UUID": consumers assert on the reason
 * rather than merely on the rejection, so a message naming only the pattern
 * would tell a caller the shape failed without saying which shape was owed.
 *
 * The explicit `z.ZodType<T, T>` return type is required because the contracts
 * package compiles with `isolatedDeclarations: true` — exported declarations
 * cannot rely on inferred return types.
 */
export function brandedUuidIdSchema<T extends string>(brandName: string): z.ZodType<T, T> {
  return z
    .string()
    .regex(RFC_9562_TEXT_FORM, "Invalid UUID: expected an RFC 9562 text form")
    .brand(brandName) as unknown as z.ZodType<T, T>;
}
