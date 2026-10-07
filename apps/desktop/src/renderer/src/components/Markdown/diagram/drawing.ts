// Draws one diagram's source into a standalone picture with mermaid, configured from the palette,
// and reshapes the result into an image at its own size. The picture is shown through an image, so
// it never enters the page as markup and its ids cannot meet another copy's.

import type { Mermaid, MermaidConfig } from "mermaid";

import { describeFailure } from "#shared/failure-message.js";
import type { DiagramPalette } from "./palette.js";

/** A diagram drawn: its picture as an image address, its natural size and the ground it sits on. */
export interface DrawnDiagram {
  readonly kind: "drawn";
  /** A `data:` address of the SVG picture. */
  readonly pictureUrl: string;
  /** The picture's natural width, in CSS pixels. */
  readonly width: number;
  /** The picture's natural height, in CSS pixels. */
  readonly height: number;
  /** The ground it was drawn for, `#rrggbb`, which a copy of it is painted on. */
  readonly groundColor: string;
}

/** What drawing one diagram came to: its picture, or the reason it has none. */
export type DiagramOutcome = DrawnDiagram | FailedDiagram;

/**
 * Draw `source` with `palette`. Never rejects: a source the library cannot draw comes back as a
 * failed outcome carrying the first line of its message. `renderId` must be unique among renders
 * in flight, since the library lays the drawing out in the page under that id.
 */
export async function drawDiagram(
  mermaid: Mermaid,
  source: string,
  palette: DiagramPalette,
  renderId: string,
): Promise<DiagramOutcome> {
  mermaid.initialize(configurationFor(palette));
  let svg: string;
  try {
    ({ svg } = await mermaid.render(renderId, source));
  } catch (error) {
    return { kind: "failed", reason: firstLineOf(describeFailure(error)) };
  }
  return pictureOf(svg, palette);
}

/** A diagram that could not be drawn, and why, in one line. */
interface FailedDiagram {
  readonly kind: "failed";
  readonly reason: string;
}

/**
 * The keys a diagram's own `%%{init}%%` directive may not change: the library's own locked set,
 * which this list replaces, then everything the palette and the image path depend on.
 */
const LOCKED_CONFIGURATION_KEYS: readonly string[] = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "fontFamily",
  "altFontFamily",
  "fontSize",
  "htmlLabels",
];

function configurationFor(palette: DiagramPalette): MermaidConfig {
  const fontSize = `${String(palette.fontSizePx)}px`;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // Labels as SVG text: an HTML label serializes as HTML (`<br>` left open), which the image's
    // XML parser refuses, so a label with a line break would leave no picture at all.
    htmlLabels: false,
    // The one theme the library derives wholly from the variables below.
    theme: "base",
    darkMode: palette.isDark,
    fontFamily: palette.fontFamily,
    fontSize: palette.fontSizePx,
    themeVariables: {
      ...palette.colors,
      darkMode: palette.isDark,
      fontFamily: palette.fontFamily,
      fontSize,
    },
    secure: [...LOCKED_CONFIGURATION_KEYS],
  };
}

/**
 * The library's SVG as a standalone image: sized by its view box rather than the column-wide width
 * and maximum it is drawn with, so the image has a natural size to lay out and copy at.
 */
function pictureOf(svg: string, palette: DiagramPalette): DiagramOutcome {
  const pictureDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = pictureDocument.documentElement;
  if (pictureDocument.querySelector("parsererror") !== null) {
    return { kind: "failed", reason: "The drawing is not a picture an image can show" };
  }
  const [, , viewWidth, viewHeight] = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (!(viewWidth !== undefined && viewWidth > 0 && viewHeight !== undefined && viewHeight > 0)) {
    return { kind: "failed", reason: "The drawing has no size" };
  }
  const width = Math.ceil(viewWidth);
  const height = Math.ceil(viewHeight);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  const markup = new XMLSerializer().serializeToString(root);
  return {
    kind: "drawn",
    pictureUrl: `data:image/svg+xml,${encodeURIComponent(markup)}`,
    width,
    height,
    groundColor: palette.groundColor,
  };
}

/** A message's first line, without the colon that introduces the lines under it. */
function firstLineOf(message: string): string {
  return (message.split("\n")[0] ?? "").trim().replace(/:$/u, "");
}
