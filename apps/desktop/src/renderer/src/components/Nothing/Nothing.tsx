// The five kinds of empty state in two shapes. They render differently because the next move
// differs for each; the kind set is closed, the traits table is total over it, and each kind
// supplies its own copy, glyph and tone.
//
//   - `not-loaded`: a skeleton in the row's shape; the read is in flight and says nothing yet.
//   - `empty`: a quiet line with the escape hatch (`action`); the read found none.
//   - `error`: the daemon's message text under an alert glyph on a red edge, never paraphrased.
//   - `not-checked`: a dotted boundary; no question was put, which is neither "no" nor unknown.
//   - `computing`: a clock glyph on a filled boundary; the answer is still being worked out.
//
// Kind is what is missing; placement is where it is mounted. `inline` is a badge beside the value
// it qualifies; `block` stands in for a region's content. A badge in place of a whole pane reads
// as unfinished paint and can only carry its second line as a tooltip. Copy is the caller's.

import "./Nothing.css";

import { GLYPH_SIZE_ROW, type GlyphName } from "#renderer/styles/glyphs.js";
import type { AnnouncementPoliteness } from "../LiveAnnouncer/announcer.js";
import { useAnnounceWhenShown } from "#renderer/hooks/announce/useAnnounceWhenShown.js";
import { Glyph } from "../Glyph/Glyph.js";

/** The closed set of empty-state kinds. */
export type NothingKind = "not-loaded" | "empty" | "error" | "not-checked" | "computing";

/** The two shapes an empty state takes. */
export type NothingPlacement = "inline" | "block";

/** Props for `Nothing`. */
export interface NothingProps {
  readonly kind: NothingKind;
  /**
   * Where this empty state is mounted. Omitted, it is the kind's ordinary placement; name it when
   * the mount differs, such as a whole pane of `not-checked`, which is `block`.
   */
  readonly placement?: NothingPlacement;
  /** What is missing, in one sentence. For `error`, the refusal's code as words, or a headline. */
  readonly title: string;
  /**
   * The second line. For `error` it is the daemon's message text, rendered verbatim; for every
   * other kind it is the app's own prose. A block renders it as prose; a badge carries it
   * as a tooltip.
   */
  readonly detail?: string;
  /** The next step, when there is one. A button, a link, a control. */
  readonly action?: React.ReactNode;
  /**
   * The attempt this state answers, for a retry that can end in the same words: a new value says
   * them again. Keep its identity across renders (the refusal the retry replaces).
   */
  readonly attempt?: unknown;
}

/** What a kind supplies, and nothing about where it is mounted. */
interface NothingKindTraits {
  /** The placement used when the caller names none; a caller may override it. */
  readonly defaultPlacement: NothingPlacement;
  /** Whether the kind has words; `not-loaded` shows a shape and only announces its title. */
  readonly copy: "prose" | "skeleton";
  /** The kind's glyph, in both shapes. Kinds that carry meaning in copy alone have none. */
  readonly glyph?: GlyphName;
  /**
   * The block form's second-line class; `error` has its own because quoted text needs a wider
   * measure.
   */
  readonly detailClassName: string;
  /**
   * The announcer lane the state's words are said on when it is drawn, in both shapes: it mounts
   * holding them, which most screen readers never announce from a live role. Absent where the
   * state is quiet.
   */
  readonly announcement?: AnnouncementPoliteness;
  /** Whether the kind is a read still in flight. */
  readonly busy?: boolean;
}

/** Total over `NothingKind`, so a new kind fails to compile until it has traits. */
const NOTHING_KIND_TRAITS: Readonly<Record<NothingKind, NothingKindTraits>> = {
  "not-loaded": {
    defaultPlacement: "block",
    copy: "skeleton",
    detailClassName: "meridian-nothing__detail",
    announcement: "polite",
    busy: true,
  },
  empty: {
    defaultPlacement: "block",
    copy: "prose",
    detailClassName: "meridian-nothing__detail",
  },
  error: {
    defaultPlacement: "block",
    copy: "prose",
    glyph: "alert",
    detailClassName: "meridian-nothing__message",
    announcement: "assertive",
  },
  "not-checked": {
    defaultPlacement: "inline",
    copy: "prose",
    detailClassName: "meridian-nothing__detail",
  },
  computing: {
    defaultPlacement: "inline",
    copy: "prose",
    glyph: "clock",
    detailClassName: "meridian-nothing__detail",
    announcement: "polite",
  },
};

/** The shape each placement renders as. */
const SHAPE_MODIFIER_BY_PLACEMENT: Readonly<Record<NothingPlacement, string>> = {
  inline: "meridian-nothing--badge",
  block: "meridian-nothing--block",
};

/** Skeleton bar widths as fractions of the measure; uneven so they do not read as a table. */
const SKELETON_BAR_WIDTHS: readonly string[] = ["38%", "82%", "61%"];

/**
 * Renders an empty state of the given kind as a badge or a block; `placement` defaults per kind.
 * Its copy comes from the caller.
 */
export function Nothing(props: NothingProps): React.JSX.Element {
  const traits = NOTHING_KIND_TRAITS[props.kind];
  const placement = props.placement ?? traits.defaultPlacement;
  const className =
    `meridian-nothing ${SHAPE_MODIFIER_BY_PLACEMENT[placement]} ` +
    `meridian-nothing--${props.kind}`;
  useAnnounceWhenShown(
    traits.announcement === undefined ? undefined : shownWords(props, traits, placement),
    traits.announcement ?? "polite",
    props.attempt,
  );
  return placement === "inline"
    ? renderBadge(props, traits, className)
    : renderBlock(props, traits, className);
}

/**
 * The badge: an empty state that qualifies the value it sits beside. A skeleton badge is one bar,
 * and carries no action because a read in flight has no next move.
 */
function renderBadge(
  props: NothingProps,
  traits: NothingKindTraits,
  className: string,
): React.JSX.Element {
  if (traits.copy === "skeleton") {
    return (
      <span className={className} aria-busy={traits.busy}>
        <span className="meridian-visually-hidden">{props.title}</span>
        <span className="meridian-nothing__skeleton-bar" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={className} aria-busy={traits.busy}>
      {traits.glyph === undefined ? null : <Glyph name={traits.glyph} size={GLYPH_SIZE_ROW} />}
      <span className="meridian-nothing__badge-label" title={props.detail}>
        {props.title}
      </span>
      {props.action === undefined ? null : (
        <span className="meridian-nothing__action">{props.action}</span>
      )}
    </span>
  );
}

/** The block: an empty state standing in for the content that is not there. */
function renderBlock(
  props: NothingProps,
  traits: NothingKindTraits,
  className: string,
): React.JSX.Element {
  if (traits.copy === "skeleton") {
    return (
      <div className={className} aria-busy={traits.busy}>
        <span className="meridian-visually-hidden">{props.title}</span>
        {SKELETON_BAR_WIDTHS.map((width) => (
          <span
            key={width}
            className="meridian-nothing__skeleton-bar"
            style={{ width }}
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }
  return (
    <div className={className} aria-busy={traits.busy}>
      <p className="meridian-nothing__title">
        {traits.glyph === undefined ? null : <Glyph name={traits.glyph} size={GLYPH_SIZE_ROW} />}
        {props.title}
      </p>
      {props.detail === undefined ? null : <p className={traits.detailClassName}>{props.detail}</p>}
      {props.action === undefined ? null : (
        <div className="meridian-nothing__action">{props.action}</div>
      )}
    </div>
  );
}

/**
 * The words the state shows: its title, and in a block of prose its second line too. A badge
 * carries that line only as a tooltip, and a skeleton shows none.
 */
function shownWords(
  props: NothingProps,
  traits: NothingKindTraits,
  placement: NothingPlacement,
): string {
  if (placement === "inline" || traits.copy === "skeleton" || props.detail === undefined) {
    return props.title;
  }
  return /[.?!…]$/u.test(props.title)
    ? `${props.title} ${props.detail}`
    : `${props.title}. ${props.detail}`;
}
