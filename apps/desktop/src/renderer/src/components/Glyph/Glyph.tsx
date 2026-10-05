// One glyph from the closed set in `styles/glyphs.ts`. Stroke, caps, joins and viewBox are
// normalized at compile time by `vitest/icon-compilation.ts`; this module decides size and name.
//
// A glyph with no `title` is decoration and hidden from assistive technology; one with a `title`
// is an image carrying that name, so an icon-only control cannot ship unlabeled.

import "./Glyph.css";

import { DEFAULT_APPEARANCE_RECORD } from "@shared/appearance.js";
import { GLYPH_DEFAULT_SIZE, type GlyphName } from "@renderer/styles/glyphs.js";
import { GLYPH_ICONS } from "./glyph-icons.js";

/** Props for `Glyph`. */
export interface GlyphProps {
  readonly name: GlyphName;
  /**
   * Edge length in CSS pixels at the default text size; drawn root-relative, so it grows with the
   * text size like the text beside it. Square by construction.
   */
  readonly size?: number;
  /** The glyph's accessible name. Omit when adjacent text already names it. */
  readonly title?: string;
}

/** Draws the face for `name` at `size`; `title` makes it an image with that accessible name. */
export function Glyph(props: GlyphProps): React.JSX.Element {
  const edgePx = props.size ?? GLYPH_DEFAULT_SIZE;
  const edge = `${String(edgePx / DEFAULT_APPEARANCE_RECORD.textSize)}rem`;
  const isLabeled = props.title !== undefined;
  const Face = GLYPH_ICONS[props.name];
  return (
    <Face
      className="meridian-glyph"
      style={{ width: edge, height: edge }}
      role={isLabeled ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={isLabeled ? undefined : true}
    />
  );
}
