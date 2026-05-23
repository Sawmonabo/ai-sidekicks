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
// ADR-014). The `MembershipUpdate` type alias is `z.infer<...>` to keep
// the type and schema in sync from a single source of truth.
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
  type MembershipId,
  type MembershipRole,
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
 * Defense-in-depth helper — assert at compile time that the four action
 * literals are exactly the canonical set. If a future edit adds, removes,
 * or renames a variant in `MembershipUpdate` below, the `Exact<...>`
 * comparison fails to typecheck. This catches the same class of
 * transcription-drift bug that motivated this entire file's existence
 * (the orchestrator's original dispatch dropped `reactivate` and used
 * kebab-case for the discriminant; both would now be caught at compile
 * time).
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
