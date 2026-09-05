// Admit one pane address that arrived untyped, or refuse it by name.
//
// The two callers are the boundaries where the compiler has no claim to make: a layout
// snapshot read back off disk, which may predate or postdate this build, and a route a
// person can type into the address bar. `pane-address.ts` beside this file owns WHICH
// pane kind is a view of WHICH entity — the rows, the union the compiler holds a typed
// call site to, and the same rows as data. This file owns what happens at the one door
// the compiler does not stand at.
//
// Its own module rather than the bottom of that file, and the seam is exactly that
// difference: the rows are a claim about the product, and this is a claim about a
// boundary. Everything here is boundary machinery — a refusal origin, an identifier
// grammar borrowed from `persistence/`, and five named refusals — and none of it is
// read by the compile-time half at all, while the compile-time half is read by every
// module that opens a pane. Keeping them together made one file that grew whenever
// either question was reopened.
//
// A REFUSAL RATHER THAN A THROW, per `core/refusal.ts`: a restored layout with one bad
// row drops that row and keeps the rest, and a caller that needs the exception shape
// wraps it in `ConsoleRefusalError` at its own seam.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { IDENTIFIER_MAX_LENGTH, isSingleNameIdentifierShaped } from "../persistence/index.js";
import { type ConsoleEntityRef } from "../store/index.js";
import {
  isEntityOptionalPaneKind,
  paneEntityScopeFor,
  type ConsolePaneAddress,
} from "./pane-address.js";
import { PANE_KINDS, isPaneKind } from "./pane-kinds.js";

/** The subsystem a pane-address refusal names as its author. */
const PANE_ADDRESS_ORIGIN = "pane-address";

/**
 * The ceiling the entity-id grammar enforces, named for the refusal sentence.
 *
 * Read off the grammar rather than restated, so the number a person is told is the
 * number the predicate applied. It is `persistence/`'s constant because the grammar
 * is `persistence/`'s — this module applies it, it does not own it.
 */
const PANE_ENTITY_ID_MAX_LENGTH = IDENTIFIER_MAX_LENGTH;

/**
 * The entity reference an untyped boundary supplied, or `undefined` when it supplied none.
 *
 * The id is held to the console's ONE identifier grammar rather than to `id.length`.
 * A non-empty check admits whitespace, a NUL, a path, and a string of any length, and
 * the parse then answered with a valid pane address whose body would query a store key
 * that can never exist — `Spec-023 §Console Design (Meridian)` §The surface set's "an
 * entity id that fails validation is rejected", unenforced.
 *
 * The grammar is `persistence/identifier-grammar.ts`'s, imported rather than restated:
 * the layout snapshot this parse reads back is written through that family's value
 * walk, so the durable boundary already holds this exact string to this exact
 * predicate. A second grammar here would let route resolution admit an id the layout
 * path refuses, which is one value with two answers.
 *
 * `packages/contracts` settles nothing broader for it. Its id schemas are per-entity
 * branded UUIDs (`SessionIdSchema` and its siblings), and `ConsoleEntityRef.id` is
 * deliberately kind-agnostic and wire-verbatim, so no contracts schema covers the
 * value this boundary holds — and none disagrees with the grammar that does.
 */
function readEntityRefCandidate(candidate: unknown): ConsoleEntityRef | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { kind, id } = candidate as { readonly kind?: unknown; readonly id?: unknown };
  return typeof kind === "string" && typeof id === "string" && isSingleNameIdentifierShaped(id)
    ? ({ kind, id } as ConsoleEntityRef)
    : undefined;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * Admit one address that arrived untyped, or refuse it by name.
 *
 * The two callers are the boundaries where the compiler has no claim to make: a
 * layout snapshot read back off disk, which may predate or postdate this build,
 * and a route a person can type. `Spec-023 §Console Design (Meridian)` §The
 * surface set requires that "an unknown pane kind is dropped and reported, and
 * an entity id that fails validation is rejected"; this is the predicate both
 * drops are made against, so neither boundary decides for itself.
 *
 * A refusal rather than a throw, per `core/refusal.ts`: a restored layout with
 * one bad row drops that row and keeps the rest, and a caller that needs the
 * exception shape wraps it in `ConsoleRefusalError` at its own seam.
 */
export function parseConsolePaneAddress(
  candidateKind: unknown,
  candidateEntity: unknown,
): ConsolePaneAddress | ConsoleRefusal {
  if (!isPaneKind(candidateKind)) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-kind-unknown",
      `"${String(candidateKind)}" is not one of the ${String(PANE_KINDS.length)} pane kinds this build renders`,
    );
  }

  const scope = paneEntityScopeFor(candidateKind);

  if (candidateEntity === undefined) {
    if (!isEntityOptionalPaneKind(candidateKind)) {
      return refuse(
        PANE_ADDRESS_ORIGIN,
        "pane-entity-required",
        `a "${candidateKind}" pane is a view of one ${scope.entityKinds.join(" or ")} and was opened with none`,
      );
    }
    // No cast. The predicate narrowed `candidateKind` to the kinds whose arm has no
    // `entity` member or an optional one, and the bare object satisfies both — which
    // is the whole point of the optional arm: what the parse returns is now a value a
    // typed caller could have written by hand.
    return { kind: candidateKind };
  }

  const entity = readEntityRefCandidate(candidateEntity);
  if (entity === undefined) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-malformed",
      // The length is named and the value is not, on the persistence grammar's own
      // discipline: a refusal that quoted the string it refused would carry that
      // string one layer past the boundary that stopped it.
      `a "${candidateKind}" pane was opened over a value that is not an entity reference — an entity reference is a kind and an identifier-shaped id (no whitespace, no path separator, at most ${String(PANE_ENTITY_ID_MAX_LENGTH)} characters)`,
    );
  }

  if (scope.entityKinds.length === 0) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-unexpected",
      `a "${candidateKind}" pane is session-scoped and takes no entity, and was opened over a "${entity.kind}"`,
    );
  }

  if (!scope.entityKinds.includes(entity.kind)) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-kind-mismatch",
      `a "${candidateKind}" pane is a view of one ${scope.entityKinds.join(" or ")} and was opened over a "${entity.kind}"`,
    );
  }

  // Sound on the same terms as the arm above, plus the admission just made:
  // `entity.kind` is now known to be one this pane kind's row lists, which is
  // exactly the union the arm's `entity` member is narrowed to.
  return { kind: candidateKind, entity } as ConsolePaneAddress;
}
