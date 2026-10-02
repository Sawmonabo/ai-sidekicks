// Admits one pane address that arrived untyped, or refuses it by name. `pane-address.ts` owns
// which pane kind is a view of which entity; this file is the boundary check against that table.

import {
  IDENTIFIER_MAX_LENGTH,
  isSingleNameIdentifierShaped,
} from "@renderer/lib/identifier-grammar.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { type EntityRef } from "@renderer/lib/entity-kinds.js";
import { isEntityOptionalPaneKind, paneEntityScopeFor, type PaneAddress } from "./pane-address.js";
import { PANE_KINDS, isPaneKind } from "./pane-kinds.js";

/** The subsystem a pane-address refusal names as its author. */
const PANE_ADDRESS_ORIGIN = "pane-address";

/** The ceiling the entity-id grammar enforces, named for the refusal sentence. */
const PANE_ENTITY_ID_MAX_LENGTH = IDENTIFIER_MAX_LENGTH;

/**
 * Admit one address that arrived untyped, or refuse it by name.
 *
 * Used where the compiler has no claim: a layout snapshot read back off disk and a route a
 * person can type. It returns a `Refusal` rather than throwing, per `lib/refusal.ts`, so a
 * restored layout drops one bad row and keeps the rest; a caller that needs an exception wraps
 * it in `RefusalError`.
 */
export function parsePaneAddress(
  candidateKind: unknown,
  candidateEntity: unknown,
): PaneAddress | Refusal {
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
    // No cast: the predicate narrowed the kind to those whose arm has no `entity` member or
    // an optional one.
    return { kind: candidateKind };
  }

  const entity = readEntityRefCandidate(candidateEntity);
  if (entity === undefined) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-malformed",
      // Names the length and not the value, so a refusal never carries refused content.
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

  // `entity.kind` is now known to be one this pane kind's row lists, which is the union the
  // arm's `entity` member is narrowed to.
  return { kind: candidateKind, entity } as PaneAddress;
}

/**
 * The entity reference an untyped boundary supplied, or `undefined` when it supplied none.
 *
 * The id is held to the app's one identifier grammar, the same predicate the durable layout
 * snapshot is written through, so route resolution never admits an id the layout path refuses.
 * `packages/contracts` has no schema for it: `EntityRef.id` is kind-agnostic and wire-verbatim.
 */
function readEntityRefCandidate(candidate: unknown): EntityRef | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { kind, id } = candidate as { readonly kind?: unknown; readonly id?: unknown };
  return typeof kind === "string" && typeof id === "string" && isSingleNameIdentifierShaped(id)
    ? ({ kind, id } as EntityRef)
    : undefined;
}
