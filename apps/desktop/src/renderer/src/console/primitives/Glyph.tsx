// One glyph, drawn from the closed family in `tokens/glyphs.ts`.
//
// The component's whole job is to make the family's rendering options
// non-negotiable: stroke, caps, joins, fill, and viewBox live here and nowhere
// else, so no call site can quietly draw a heavier or a filled icon and no glyph
// drifts from its siblings.
//
// Accessibility is decided by one prop rather than by the caller's discipline. A
// glyph with no `title` is decoration beside text that already says what the
// control does — it is hidden from assistive technology, because announcing
// "graphic" beside a label the user has already heard is noise. A glyph WITH a
// `title` is the control's only name, so it becomes an image carrying that name.
// There is no third case, which is why an icon-only control in this console cannot
// ship unlabelled by accident.

import { type GlyphName } from "../tokens/index.js";
import {
  GLYPH_DEFAULT_SIZE,
  GLYPH_PATHS,
  GLYPH_STROKE_WIDTH,
  GLYPH_VIEWBOX_SIZE,
} from "../tokens/glyphs.js";

export type { GlyphName };

export interface GlyphProps {
  readonly name: GlyphName;
  /** Rendered edge length in CSS pixels. Square by construction. */
  readonly size?: number;
  /** The glyph's accessible name. Omit when adjacent text already names it. */
  readonly title?: string;
}

export function Glyph(props: GlyphProps): React.JSX.Element {
  const size = props.size ?? GLYPH_DEFAULT_SIZE;
  const isLabelled = props.title !== undefined;
  return (
    <svg
      className="meridian-glyph"
      width={size}
      height={size}
      viewBox={`0 0 ${String(GLYPH_VIEWBOX_SIZE)} ${String(GLYPH_VIEWBOX_SIZE)}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={GLYPH_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={isLabelled ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={isLabelled ? undefined : true}
    >
      <path d={GLYPH_PATHS[props.name]} />
    </svg>
  );
}
