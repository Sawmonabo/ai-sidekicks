// Membership contracts — request payload for Plan-002 Phase 1 membership
// mutations. Implements the C3 acceptance criterion (Plan-002 §C3, Spec-002
// line 83): `MembershipUpdate.action` discriminated union covers role change,
// suspension, revocation, and reactivation.
//
// Canonical wire form lives in
// docs/architecture/contracts/api-payload-contracts.md lines 400-410:
//
//   interface MembershipUpdateRequest {
//     membershipId: MembershipId;
//     action: "change_role" | "suspend" | "revoke" | "reactivate";
//     newRole?: MembershipRole; // required for change_role
//   }
//
// Key design decisions (cite each before editing the schema):
//
//   1. FOUR actions, not three. `reactivate` lifts a `suspended` / `revoked`
//      membership back to `active`; service-layer rules (Plan-002 Phase 2
//      T2.3) govern when it is admissible. Dropping `reactivate` would
//      foreclose the canonical surface and break api-payload-contracts.md.
//
//   2. Discriminant is `change_role` (snake_case), NOT `role-change`
//      (kebab-case). The canonical wire form binds the literal string;
//      Plan-002 §I-002-1 verification (P6 test row) uses `change_role`
//      directly. The brief English gloss at Plan-002:134 is informal
//      summary, not the wire string.
//
//   3. NO `sessionId` field. `MembershipId` is a globally-unique UUID
//      (see session.ts:59) — the membership row identifies its session.
//      Including `sessionId` would invite a class of client bugs where
//      the two fields disagree and force the service to perform an
//      additional (sessionId, membershipId) consistency check that buys
//      nothing the foreign-key constraint does not already give.
//
//   4. NO `reason` field on suspend/revoke. Spec-002 line 82 carries
//      `reason?` only on `InviteRevoke`; Spec-002 line 48 routes
//      role-change and membership-revocation audit detail to session
//      events (the `session.update.membership` event payload owned by
//      Plan-006), not the request body. Adding `reason` here invents
//      wire surface absent from every governance doc.
//
//   5. `newRole` admits ALL `MembershipRole` values including `owner`.
//      Spec-002 line 49 + Plan-002 §I-002-1 explicitly allow an existing
//      owner to promote another active member via
//      `{action: "change_role", newRole: "owner"}`. The "only existing
//      owners may elevate" guard is a SERVICE-LAYER check owned by
//      Plan-002 Phase 2 T2.3 (verified by P6 in Plan-002:147), NOT a
//      schema constraint. Using `NonOwnerMembershipRoleSchema` here
//      would break owner-elevation entirely.
//
// `MembershipRole` / `MembershipState` / `MembershipId` (+ their schemas
// and the `NonOwnerMembershipRole` type alias) are RE-EXPORTED from
// session.ts. They live in session.ts because they are also consumed by
// `MembershipSummary` (session.ts:233-246) which ships in Plan-001's
// surface; moving them here would be a cross-plan ownership trespass on
// the file Plan-001 Phase 2 owns. Re-exporting gives consumers an
// ergonomic single-import surface (`import { MembershipUpdateSchema,
// MembershipRole } from "@ai-sidekicks/contracts"`) without duplicating
// the canonical declarations.
//
// `isolatedDeclarations: true` (from tsconfig.base.json) forbids inferred
// types on exported declarations. The discriminated-union schema uses the
// `as unknown as z.ZodType<T, T>` cast pattern that bridges Zod v4's
// internal discriminated-union output type to the double-T shape required
// for Standard-Schema-V1 input inference in tRPC v11 consumers (per
// ADR-014). `MembershipUpdate` is hand-declared as an explicit 4-arm
// discriminated union (NOT `z.infer<typeof MembershipUpdateSchema>`); the
// `_ActionPin` compile-time assertion below provides the type↔schema
// cross-check via mutual `extends`. `z.infer` was rejected because (a) it
// creates a TS9010 reference cycle with the
// `z.ZodType<MembershipUpdate, MembershipUpdate>` schema annotation that
// `isolatedDeclarations: true` cannot resolve, and (b) it erases the
// literal-typed `action` discriminator at the consumption site, defeating
// the bidirectional drift check that `_ActionPin` and the test backstops
// rely on.
//
// Refs: Spec-002 §Interfaces And Contracts (line 83) + §Required Behavior
// (line 49), Plan-002 §Phase 1 (C3), Plan-002 §I-002-1 (owner-elevation
// invariant — service layer), docs/architecture/contracts/api-payload-
// contracts.md §MembershipUpdate (lines 399-410), ADR-014 (tRPC v11 /
// Standard Schema V1), ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import {
  MembershipIdSchema,
  MembershipRoleSchema,
  MembershipStateSchema,
  type MembershipId,
  type MembershipRole,
  type MembershipState,
} from "./session.js";

// --------------------------------------------------------------------------
// Re-exports from session.ts
// --------------------------------------------------------------------------
//
// Consumers wiring up membership flows should `import { ... } from
// "@ai-sidekicks/contracts"` and get all the related symbols in one shot.
// session.ts remains the single source of truth (Plan-001 Phase 2 ownership);
// this file does NOT re-declare any of these symbols.
//
// Type-only re-exports MUST use `export type { ... }` (the `isolatedModules`
// + `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form).

export type {
  MembershipId,
  MembershipRole,
  MembershipState,
  NonOwnerMembershipRole,
} from "./session.js";
export { MembershipIdSchema, MembershipRoleSchema, MembershipStateSchema } from "./session.js";

// --------------------------------------------------------------------------
// MembershipUpdate — Spec-002 line 83 + api-payload-contracts.md lines 400-410
// --------------------------------------------------------------------------
//
// Discriminated union over `action`. Variant shapes:
//
//   * change_role — `{membershipId, action: "change_role", newRole}`
//     `newRole` is REQUIRED; admits any `MembershipRole` including `owner`
//     (owner-elevation permission guard is service-layer per I-002-1).
//
//   * suspend    — `{membershipId, action: "suspend"}`
//     Transitions membership to `suspended`. No payload beyond the
//     discriminator + id. Service layer (T2.3) enforces last-owner-cannot-
//     leave / source-of-truth rules.
//
//   * revoke     — `{membershipId, action: "revoke"}`
//     Transitions membership to `revoked`. No payload beyond the
//     discriminator + id. Plan-002 Spec lines 60-62 govern the side
//     effects (mid-run interruption for runtime contributors, grace
//     window for collaborators).
//
//   * reactivate — `{membershipId, action: "reactivate"}`
//     Lifts a `suspended` / `revoked` membership back to `active`.
//     Service layer governs admissibility (Plan-002 Phase 2).
//
// `.strict()` on each variant rejects unknown keys — anti-leakage matching
// every other request schema in the package. The discriminator dispatch
// also rejects a `newRole` field on non-`change_role` variants and rejects
// a missing `newRole` on `change_role`, surfacing the conditional shape at
// parse time rather than service time.

/**
 * Defense-in-depth — this pin catches transcription-drift bugs that add,
 * remove, or rename a discriminant literal. The mutual `extends` check
 * below collapses `_ActionPin` to `never` (failing compilation) under
 * three drift modes: subset shrinkage (a variant is dropped), superset
 * growth (an extra variant is added), or a rename (e.g.,
 * `change_role` → `changeRole`). The pin's correctness is the load-
 * bearing guarantee that `MembershipUpdate["action"]` cannot silently
 * diverge from the four canonical snake_case literals enumerated in
 * `ExpectedMembershipUpdateAction` below.
 */
type ExpectedMembershipUpdateAction = "change_role" | "suspend" | "revoke" | "reactivate";

export type MembershipUpdate =
  | {
      membershipId: MembershipId;
      action: "change_role";
      newRole: MembershipRole;
    }
  | {
      membershipId: MembershipId;
      action: "suspend";
    }
  | {
      membershipId: MembershipId;
      action: "revoke";
    }
  | {
      membershipId: MembershipId;
      action: "reactivate";
    };

// Compile-time pin — TS fails if `MembershipUpdate["action"]` drifts from
// the canonical set. Mutual `extends` checks both subset and superset.
type _ActionPin = ExpectedMembershipUpdateAction extends MembershipUpdate["action"]
  ? MembershipUpdate["action"] extends ExpectedMembershipUpdateAction
    ? true
    : never
  : never;
// `void` suppresses TS6133 (unused). The pin's value is its TYPE not its
// runtime — referencing it as a value would not survive `isolatedDeclarations`.
const _actionPinHolder: _ActionPin = true;
void _actionPinHolder;

// `z.discriminatedUnion` requires every variant to be a literal-typed
// `z.ZodObject` sharing the discriminator key. We construct each variant
// inline (NOT via a `z.ZodType<T>`-annotated intermediate const) because
// the abstract `z.ZodType<T>` annotation erases the literal-typed `action`
// field that `discriminatedUnion` needs to dispatch on. The same pattern
// is used by `SessionEventSchema` in `event.ts:378` — see the comment
// block there at lines 360-376 for the load-bearing rationale.
//
// The outer `as unknown as z.ZodType<MembershipUpdate, MembershipUpdate>`
// cast bridges Zod v4's internal discriminated-union output type to the
// double-T `z.ZodType<T, T>` shape required for Standard-Schema-V1 input
// inference in tRPC v11 consumers (per ADR-014). Same bridge pattern as
// `brandedUuidIdSchema` in `./internal/branded.ts`.

export const MembershipUpdateSchema: z.ZodType<MembershipUpdate, MembershipUpdate> =
  z.discriminatedUnion("action", [
    z
      .object({
        membershipId: MembershipIdSchema,
        action: z.literal("change_role"),
        newRole: MembershipRoleSchema,
      })
      .strict(),
    z
      .object({
        membershipId: MembershipIdSchema,
        action: z.literal("suspend"),
      })
      .strict(),
    z
      .object({
        membershipId: MembershipIdSchema,
        action: z.literal("revoke"),
      })
      .strict(),
    z
      .object({
        membershipId: MembershipIdSchema,
        action: z.literal("reactivate"),
      })
      .strict(),
  ]) as unknown as z.ZodType<MembershipUpdate, MembershipUpdate>;

// --------------------------------------------------------------------------
// MembershipUpdateResponse — api-payload-contracts.md §Tier 2 (lines 406-410)
// --------------------------------------------------------------------------
//
// `{membershipId, state, role, updatedAt}`. The wire RESPONSE returned by the
// control-plane membership service after a `MembershipUpdate` mutation. It
// lands here (the contracts package) so the producer (`@ai-sidekicks/control-
// plane` MembershipService) and the SDK consumer (Plan-002 Phase 5 client
// SDK) share ONE source of truth instead of duplicating the local interface
// (membership-service.ts:173-178, shipped in PR #105). The as-built shape is
// canonical; `api-payload-contracts.md §Tier 2` already agrees on this shape
// (no doc edit needed for this response).
//
// `state` is the membership's post-mutation `MembershipState`; `role` is its
// `MembershipRole` (unchanged on suspend / revoke / reactivate; the new role
// on `change_role`). `updatedAt` matches the ISO 8601 convention used across
// this package's wire timestamps (`z.iso.datetime({ offset: true })` — RFC
// 3339 §5.6 offsets accepted alongside the Z-suffixed UTC form).
//
// Annotation posture: double-T `z.ZodType<T, T>` (per channels.ts, the
// Plan-002 Phase 1 sibling) so tRPC v11's Standard-Schema-V1 INPUT inference
// resolves to T and not `unknown` at consumer sites (ADR-014). The schema is
// non-transforming, so Input ≡ Output ≡ T. `.strict()` rejects unknown keys —
// universal across this package's response schemas.
//
// NOT-FOUND IS A TYPED WIRE ERROR, NOT A NULLABLE RESULT. This schema models
// the SUCCESS projection only; the non-nullable shape is deliberate. When no
// membership row matches the target `membershipId`, the control-plane
// `updateMembership` returns an internal `null` sentinel (its own documented
// contract: see the `@returns ... null ...` docstring at membership-
// service.ts:227-229 and the "unknown membership (the wire layer surfaces a
// typed not-found)" comment at membership-service.ts:282-283) that the
// wire/daemon layer translates to a typed not-found error (error-contracts.md
// §Error Codes) — delivered as a JSON-RPC error envelope, never as a
// `result: null`. A daemon-bridge author must therefore never emit
// `result: null` against this schema.

export interface MembershipUpdateResponse {
  membershipId: MembershipId;
  state: MembershipState;
  role: MembershipRole;
  updatedAt: string;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts; double-T
// per channels.ts / ADR-014 (preserves Standard-Schema-V1 input inference).
// The `as unknown as z.ZodType<T, T>` cast bridges the underlying
// `z.ZodObject<...>` (whose `_input.state` / `_input.role` resolve to
// `unknown` because `MembershipStateSchema` / `MembershipRoleSchema` from
// session.ts are the single-T `z.ZodType<T>` form) to the double-T target
// required for Standard-Schema-V1 input inference at tRPC v11 consumer sites.
// Same bridge pattern as `MembershipUpdateSchema` above (memberships.ts:228)
// and `ChannelListResponseChannelSchema` (channels.ts:237).
export const MembershipUpdateResponseSchema: z.ZodType<
  MembershipUpdateResponse,
  MembershipUpdateResponse
> = z
  .object({
    membershipId: MembershipIdSchema,
    state: MembershipStateSchema,
    role: MembershipRoleSchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict() as unknown as z.ZodType<MembershipUpdateResponse, MembershipUpdateResponse>;
