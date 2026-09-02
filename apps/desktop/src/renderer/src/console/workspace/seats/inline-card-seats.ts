// The three inline cards a ledger row can carry, and the seat each body fills.
//
// `Spec-023 §Console Design (Meridian)` rule 7 puts these in the timeline: "diff
// cards expand to a height cap and then offer 'show all'". A diff, an attachment,
// and a published artifact each render as a card INSIDE a row rather than as a
// pane, because they belong to the turn that produced them.
//
// TWO FAMILIES MEET HERE. The workspace family (T-023p-1C-2) owns the ledger and
// renders the seat; the repos family (T-023p-1C-5) owns all three bodies. The
// ledger imports no body and the bodies import no ledger.
//
// WHY THE PROPS CARRY IDENTITY AND NOTHING ELSE
//
// A card body needs the artifact's size, its media type, its allow-list verdict —
// and NONE of those is a wire member that exists. `Plan-023 §Console growth slate`
// carries `artifact-ingest-and-crud` ("attachment ingest method-name table and
// artifact CRUD method strings", owned by Plan-014) and
// `artifact-allowlist-and-abort` ("effective allow-list read; ingest abort", owned
// by Spec-014) precisely because they do not. Minting a `ConsoleArtifact` shape
// here with the members a card would like would be the console inventing wire
// members, which `store/entities.ts` names as the lane-4 change Phase 1C forbids.
//
// So each arm carries the identity its body fetches WITH, and the fetch goes
// through `bridge/growth-port.ts`, which refuses by name until the wire lands. The
// day Plan-014 registers the typed attachment reference, the local
// `InlineCardAttachmentRef` below is deleted and the contract type imported in its
// place — one edit, in the PR that removes the slate rows.

import { ConsoleRefusalError, KeyedRegistry, refuse } from "../../core/index.js";
import { type ConsoleEntityRef } from "../../store/index.js";

/** The subsystem an inline-card refusal names as its author. */
const INLINE_CARD_ORIGIN = "inline-card-seats";

// Consumed by T-023p-1C-2
/**
 * Every kind of card a ledger row can carry. Closed.
 *
 * The tuple is the declaration and the union is derived from it, for the reason
 * `pane-kinds.ts` gives about its own set.
 */
export const INLINE_CARD_KINDS = ["diff", "attachment", "artifact"] as const;

// Consumed by T-023p-1C-2, T-023p-1C-5
/** One inline-card kind. Derived from the enumeration, never restated. */
export type InlineCardKind = (typeof INLINE_CARD_KINDS)[number];

// Consumed by T-023p-1C-2, T-023p-1C-5
/**
 * A reference to an attachment on a message.
 *
 * Renderer-local and identity-only, and it is a placeholder with a named owner
 * rather than a guess: `Spec-014 §Required Behavior` types the attachment
 * reference and Plan-014 T14.13 builds it, and until that lands
 * `@ai-sidekicks/contracts` exports no attachment type at all —
 * `SteerPayload.attachments` is `unknown[]` by contract. When the typed reference
 * ships, this interface is deleted and the contract type is imported at the arm
 * below.
 */
export interface InlineCardAttachmentRef {
  /** Opaque, wire-verbatim. The only thing the console can honestly hold today. */
  readonly attachmentId: string;
}

// Consumed by T-023p-1C-2, T-023p-1C-5
/**
 * A diff card, over one computed diff.
 *
 * The two identifiers are the ones the registered diff result carries — the
 * `DiffArtifactCreateResponse` in
 * `docs/architecture/contracts/api-payload-contracts.md` §Plan-011, whose members
 * are `diffArtifactId`, `artifactManifestId`, and `createdAt`. They are spelled flat
 * here because that response is flat, so the arm and the wire it is fetched with
 * read as one shape.
 *
 * This arm used to carry a `changeSetId`, which had no producer, no consumer, and no
 * registration anywhere in the corpus: a card body handed one had nothing to fetch
 * with, and the identifier looked exactly like a wire fact while being traceable to
 * nothing. Both members are needed rather than one — the diff and the artifact
 * manifest it mints are two rows, and a body renders the diff while its provenance
 * and retention hang off the manifest.
 *
 * `packages/contracts` exports no diff type yet, so these are plain strings, the
 * same posture (and the same deletion obligation) `InlineCardAttachmentRef` above
 * takes: when the contracts package registers the response, these members take its
 * branded ids and this comment goes with the change.
 */
export interface DiffInlineCardProps {
  readonly kind: "diff";
  readonly runId: string;
  readonly diffArtifactId: string;
  readonly artifactManifestId: string;
}

// Consumed by T-023p-1C-2, T-023p-1C-5
/** An attachment card, over one message attachment. */
export interface AttachmentInlineCardProps {
  readonly kind: "attachment";
  readonly attachment: InlineCardAttachmentRef;
}

// Consumed by T-023p-1C-2, T-023p-1C-5
/**
 * A reference to one entity in the console's `artifact` partition.
 *
 * `ConsoleEntityRef` narrowed to the one kind this card can render, EXTENDED from
 * it rather than restated: `id` keeps its single home, and `kind` is fixed to the
 * literal. The unnarrowed ref admits all twelve kinds, so a caller could hand the
 * artifact card a `run` reference and the body would look the row up in a partition
 * that has never held it — a card that renders as permanently missing, which is
 * indistinguishable from an artifact the fetch has not answered for yet.
 *
 * The narrowing is the whole guard, and deliberately so: this arm is reached from
 * typed call sites inside the renderer, never from a wire payload, so there is no
 * boundary at which an untyped `kind` could arrive and nothing for a runtime check
 * to catch that the compiler has not already refused.
 */
export interface ArtifactEntityRef extends ConsoleEntityRef {
  readonly kind: "artifact";
}

// Consumed by T-023p-1C-2, T-023p-1C-5
/**
 * An artifact card, over one published artifact.
 *
 * Carries an entity reference because `artifact` is already one of the console's
 * own entity kinds — the store partitions artifacts, and a second identity
 * vocabulary for the same rows would be the denormalised copy `store/entities.ts`
 * refuses. It carries the ARTIFACT-partitioned reference specifically, for the
 * reason on that type.
 */
export interface ArtifactInlineCardProps {
  readonly kind: "artifact";
  readonly artifact: ArtifactEntityRef;
}

// Consumed by T-023p-1C-2, T-023p-1C-5
/**
 * The props each card kind's body receives, declared once and indexed by kind.
 *
 * A map rather than three parallel declarations, so `InlineCardSeatProps` below
 * and every per-kind signature in this file are derived from one place. A kind
 * added to `INLINE_CARD_KINDS` without an entry here fails to compile at this
 * type, which is the reminder that a card kind without props is a kind nothing
 * can render.
 */
export interface InlineCardPropsByKind {
  readonly diff: DiffInlineCardProps;
  readonly attachment: AttachmentInlineCardProps;
  readonly artifact: ArtifactInlineCardProps;
}

// Consumed by T-023p-1C-2
/** The discriminated union of every card's props. Narrow on `kind`. */
export type InlineCardSeatProps = InlineCardPropsByKind[InlineCardKind];

// Consumed by T-023p-1C-5
/** What a family registers to fill one card kind's body. */
export interface InlineCardBodyDescriptor<TKind extends InlineCardKind = InlineCardKind> {
  /** The task or family that owns it, so an unfilled card names someone. */
  readonly owner: string;
  readonly render: (props: InlineCardPropsByKind[TKind]) => React.ReactNode;
}

// Consumed by T-023p-1C-2
export class InlineCardSeatRegistry {
  // `"owner-scoped"`, for `frame/surface-registry.ts`'s reason: a hot reload
  // re-runs the owning family's module and must replace, while two owners on one
  // card kind is a conflict rather than a swap decided by import order.
  readonly #bodiesByKind = new KeyedRegistry<InlineCardKind, InlineCardBodyDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "inline card body",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "a ledger row renders one body per card kind",
  });

  /**
   * Claim one card kind.
   *
   * The body is written against ITS OWN arm — `(props: DiffInlineCardProps)` — and
   * stored in a table whose value type spans all three. TypeScript cannot see that
   * a body registered under `"diff"` is only ever read back under `"diff"`, because
   * the relation runs through a `Map` key; the wrapper below is where that relation
   * is made true at runtime instead of asserted. A mismatched arm refuses by name
   * rather than reaching a body typed against a different shape.
   */
  public register<TKind extends InlineCardKind>(
    kind: TKind,
    descriptor: InlineCardBodyDescriptor<TKind>,
  ): void {
    this.#bodiesByKind.register(kind, {
      owner: descriptor.owner,
      render: (props) => {
        if (props.kind !== kind) {
          throw new ConsoleRefusalError(
            refuse(
              INLINE_CARD_ORIGIN,
              "card-kind-mismatch",
              `the "${kind}" inline card body was handed "${props.kind}" props`,
            ),
          );
        }
        // Sound because of the guard immediately above: `props.kind` and the key
        // this body was registered under are now known to be the same literal, and
        // `InlineCardPropsByKind` is keyed by exactly that discriminant.
        return descriptor.render(props as InlineCardPropsByKind[TKind]);
      },
    });
  }

  public unregister(kind: InlineCardKind): void {
    this.#bodiesByKind.unregister(kind);
  }

  public bodyFor(kind: InlineCardKind): InlineCardBodyDescriptor | undefined {
    return this.#bodiesByKind.get(kind);
  }

  /** Which card kinds have a body, in declaration order. */
  public registeredCardKinds(): readonly InlineCardKind[] {
    return INLINE_CARD_KINDS.filter((kind) => this.#bodiesByKind.has(kind));
  }

  /**
   * Render one card. The door the ledger row uses.
   *
   * Keyed on the props' OWN discriminant, so the body reached is by construction
   * the one registered for that arm — the reason the guard in `register` is a
   * backstop for the descriptor door rather than the mechanism this path relies
   * on. An unfilled kind renders nothing here; a caller that needs to TELL an
   * unfilled kind from a body that rendered nothing asks `bodyFor` instead, which
   * is the "reserved, not stubbed" question and has its own answer.
   */
  public render(props: InlineCardSeatProps): React.ReactNode {
    return this.#bodiesByKind.get(props.kind)?.render(props);
  }
}

// Consumed by T-023p-1C-2
/** The process-wide registry the repos family calls at module scope. */
export const inlineCardSeatRegistry: InlineCardSeatRegistry = new InlineCardSeatRegistry();

// Consumed by T-023p-1C-5
/** The call a family makes to fill one card kind's body. */
export function registerInlineCardBody<TKind extends InlineCardKind>(
  kind: TKind,
  descriptor: InlineCardBodyDescriptor<TKind>,
): void {
  inlineCardSeatRegistry.register(kind, descriptor);
}

// Consumed by T-023p-1C-2
/** One card kind's body, or `undefined` while nobody has filled it. */
export function inlineCardBody(kind: InlineCardKind): InlineCardBodyDescriptor | undefined {
  return inlineCardSeatRegistry.bodyFor(kind);
}
