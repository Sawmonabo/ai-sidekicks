// The inline cards a transcript row can carry (diff, attachment, artifact) and the registry
// each body fills. The transcript renders them (`features/transcript/rows/InlineCards.tsx`);
// the repos, composer and inspector features register the bodies. Neither side imports the other.
//
// Props carry identity only: size, media type and allow-list verdict are not wire members, and
// the renderer must not invent them. Each body fetches with the identity its arm carries.

import { RefusalError, refuse } from "@renderer/lib/refusal/refusal.js";
import { KeyedRegistry } from "@renderer/lib/keyed-registry.js";
import { type EntityRef } from "@renderer/lib/entity-kinds.js";

/** The subsystem an inline-card refusal names as its author. */
const INLINE_CARD_ORIGIN = "inline-cards";

/**
 * Every kind of card a transcript row can carry; the closed tuple `InlineCardKind` derives from.
 */
export const INLINE_CARD_KINDS = ["diff", "attachment", "artifact"] as const;

/** One inline-card kind. */
export type InlineCardKind = (typeof INLINE_CARD_KINDS)[number];

/** A renderer-local, identity-only reference to an attachment on a message. */
export interface InlineCardAttachmentRef {
  /** Opaque and wire-verbatim. */
  readonly attachmentId: string;
}

/**
 * A diff card, over one computed diff. Both identifiers are needed: the diff and the artifact
 * manifest it mints are two rows, and a body renders the diff while provenance and retention
 * hang off the manifest. They are plain strings because the contracts package has no diff type.
 */
export interface DiffInlineCardProps {
  readonly kind: "diff";
  readonly runId: string;
  readonly diffArtifactId: string;
  readonly artifactManifestId: string;
  /**
   * The base state of the comparison, where the row knows it. Optional, and read only as a pair
   * with `headRef`, since a base with no head names nothing. The registry only carries the type.
   */
  readonly baseRef?: string;
  /** The head state of the comparison; read only with `baseRef`. */
  readonly headRef?: string;
}

/** An attachment card, over one message attachment. */
export interface AttachmentInlineCardProps {
  readonly kind: "attachment";
  readonly attachment: InlineCardAttachmentRef;
}

/**
 * A reference to one entity in the `artifact` partition: `EntityRef` with `kind` fixed. The
 * narrowing is the whole guard, since a `run` reference would look up a partition that never holds
 * it and render as permanently missing. Callers are typed, so no runtime check is needed.
 */
export interface ArtifactEntityRef extends EntityRef {
  readonly kind: "artifact";
}

/** An artifact card, over one published artifact; it reuses the store's entity reference. */
export interface ArtifactInlineCardProps {
  readonly kind: "artifact";
  readonly artifact: ArtifactEntityRef;
}

/** The props each card kind's body receives, indexed by kind; the per-kind types derive from it. */
export interface InlineCardPropsByKind {
  readonly diff: DiffInlineCardProps;
  readonly attachment: AttachmentInlineCardProps;
  readonly artifact: ArtifactInlineCardProps;
}

/** The union of every card's props; narrow on `kind`. */
export type InlineCardProps = InlineCardPropsByKind[InlineCardKind];

/** What a feature registers to fill one card kind's body. */
export interface InlineCardBodyDescriptor<TKind extends InlineCardKind = InlineCardKind> {
  /** The feature that owns the body. */
  readonly owner: string;
  readonly render: (props: InlineCardPropsByKind[TKind]) => React.ReactNode;
}

/**
 * The inline-card bodies by kind; the same owner replaces on hot reload, another owner is refused.
 */
export class InlineCardRegistry {
  readonly #bodiesByKind = new KeyedRegistry<InlineCardKind, InlineCardBodyDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "inline card body",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "a transcript row renders one body per card kind",
  });

  /**
   * Claims one card kind. The body is typed against its own arm but stored in a table spanning
   * all three, so the wrapper checks the kind at runtime and throws a named `RefusalError` on a
   * mismatch instead of running a body against another shape.
   */
  public register<TKind extends InlineCardKind>(
    kind: TKind,
    descriptor: InlineCardBodyDescriptor<TKind>,
  ): void {
    this.#bodiesByKind.register(kind, {
      owner: descriptor.owner,
      render: (props) => {
        if (props.kind !== kind) {
          throw new RefusalError(
            refuse(
              INLINE_CARD_ORIGIN,
              "card-kind-mismatch",
              `the "${kind}" inline card body was handed "${props.kind}" props`,
            ),
          );
        }
        // Sound because the guard above proves `props.kind` is the registered key.
        return descriptor.render(props as InlineCardPropsByKind[TKind]);
      },
    });
  }

  /** Removes the body for one kind. */
  public unregister(kind: InlineCardKind): void {
    this.#bodiesByKind.unregister(kind);
  }

  /** The registered body for a kind, or `undefined` while nobody has filled it. */
  public bodyFor(kind: InlineCardKind): InlineCardBodyDescriptor | undefined {
    return this.#bodiesByKind.get(kind);
  }

  /** Which card kinds have a body, in declaration order. */
  public registeredCardKinds(): readonly InlineCardKind[] {
    return INLINE_CARD_KINDS.filter((kind) => this.#bodiesByKind.has(kind));
  }

  /**
   * Renders one card, keyed on the props' own kind. An unfilled kind renders nothing; a caller
   * that must tell that from a body that rendered nothing asks `bodyFor`.
   */
  public render(props: InlineCardProps): React.ReactNode {
    return this.#bodiesByKind.get(props.kind)?.render(props);
  }
}

/** The process-wide registry the repos, composer and inspector features register into. */
export const inlineCardRegistry: InlineCardRegistry = new InlineCardRegistry();
