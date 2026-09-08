// One glyph, drawn from the closed family in `tokens/glyphs.ts`.
//
// The component's whole job is to make the family's rendering options
// non-negotiable. Stroke, caps, joins, fill, and viewBox are baked into each
// face at compile time by `vitest/icon-compilation.ts` — one normalization over
// both collections, so a borrowed Tabler face and one of our own arrive at the
// same weight — and what is left for this module is the pair of decisions a
// CALLER could otherwise get wrong: how large the glyph renders, and whether it
// carries a name.
//
// Accessibility is decided by one prop rather than by the caller's discipline. A
// glyph with no `title` is decoration beside text that already says what the
// control does — it is hidden from assistive technology, because announcing
// "graphic" beside a label the user has already heard is noise. A glyph WITH a
// `title` is the control's only name, so it becomes an image carrying that name.
// There is no third case, which is why an icon-only control in this console cannot
// ship unlabelled by accident.
//
// The face is rendered as a component rather than as a `<path>` inside an `<svg>`
// this module writes, and the props below land on that face's own root element.
// A compiled face forwards every prop it is given, so the class, the size, and
// the accessibility attributes are set exactly where they were before.

import { GLYPH_DEFAULT_SIZE, type GlyphName } from "../tokens/index.js";
import { GLYPH_FACES } from "./glyph-faces.js";

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
  const Face = GLYPH_FACES[props.name];
  return (
    <Face
      className="meridian-glyph"
      width={size}
      height={size}
      role={isLabelled ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={isLabelled ? undefined : true}
    />
  );
}
