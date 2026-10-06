// One glyph from the closed set in `styles/glyphs.ts`. Stroke, caps, joins and viewBox are
// normalized at compile time by `vitest/icon-compilation.ts`; this module decides size and name.
//
// A glyph with no `title` is decoration and hidden from assistive technology; one with a `title`
// is an image carrying that name, so an icon-only control cannot ship unlabeled.

import "./Glyph.css";

import { GLYPH_DEFAULT_SIZE, type GlyphName } from "#renderer/styles/glyphs.js";
import { GLYPH_ICONS } from "./icons.js";

/** Props for `Glyph`. */
export interface GlyphProps {
  readonly name: GlyphName;
  /**
   * Edge length in CSS pixels, at every text size: a glyph is drawn, not measured, so it stays put
   * while the text beside it grows. Square by construction.
   */
  readonly size?: number;
  /** The glyph's accessible name. Omit when adjacent text already names it. */
  readonly title?: string;
}

/** Draws the face for `name` at `size`; `title` makes it an image with that accessible name. */
export function Glyph(props: GlyphProps): React.JSX.Element {
  const size = props.size ?? GLYPH_DEFAULT_SIZE;
  const isLabeled = props.title !== undefined;
  const Face = GLYPH_ICONS[props.name];
  return (
    <Face
      className="meridian-glyph"
      width={size}
      height={size}
      role={isLabeled ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={isLabeled ? undefined : true}
    />
  );
}
