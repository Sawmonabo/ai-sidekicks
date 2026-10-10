// Draws one diagram's source into a standalone picture with merman, configured from the palette,
// its labels sized in the page's faces, and reshapes the result into an image at its own size. It
// runs in the diagram worker, which has no document, so the picture is reshaped as text. The
// picture is shown through an image, so it never enters the page as markup, runs no script and
// loads nothing.

import {
  isBindingErrorPayload,
  renderSvgWithTextMeasurer,
  type HostTextMeasurer,
  type MermaidSiteConfig,
} from "@mermanjs/web-render";

import { describeFailure } from "#shared/failure-message.js";
import type { DiagramPalette } from "../palette.js";
import {
  DRAWING_DEADLINE_MS,
  type DiagramDrawing,
  type DiagramOutcome,
  type DiagramPictureKind,
  type LabelMeasureRequest,
} from "./messages.js";
import type { LabelWidths } from "./text-measurer.js";

/** Asks the page to measure labels; resolves whether its answer came before the wait ran out. */
export type PageLabelMeasuring = (labels: readonly LabelMeasureRequest[]) => Promise<boolean>;

/**
 * Draw `source` with its labels sized in the page's faces: a first pass from the widths kept and,
 * when it met labels the cache lacks, a second once the page has measured them. When the page does
 * not answer in time, the first pass is the picture, its missing labels measured by merman's own
 * rules. Throws as `drawDiagram` does.
 */
export async function drawMeasuredDiagram(
  source: string,
  palette: DiagramPalette,
  pictureKind: DiagramPictureKind,
  labelWidths: LabelWidths,
  measureOnPage: PageLabelMeasuring,
): Promise<DiagramDrawing> {
  const firstPass = labelWidths.pass(palette.fontFamily);
  const drawing = drawDiagram(source, palette, pictureKind, firstPass.measurer);
  const misses = firstPass.misses();
  if (misses.length === 0 || drawing.status !== "settled" || drawing.outcome.kind !== "drawn") {
    return drawing;
  }
  if (!(await measureOnPage(misses))) {
    return { status: "unmeasured", outcome: drawing.outcome };
  }
  const secondPass = labelWidths.pass(palette.fontFamily);
  const redrawn = drawDiagram(source, palette, pictureKind, secondPass.measurer);
  // A line broken inside a word asks for widths only the first widths reveal; they are measured
  // for the next drawing rather than holding this one.
  const leftover = secondPass.misses();
  if (leftover.length > 0) {
    void measureOnPage(leftover);
  }
  return redrawn;
}

/**
 * Draw `source` with `palette` once, its labels measured by `textMeasurer`. A source merman
 * refuses comes back as a failed outcome carrying its message, and a drawing that ran past its
 * deadline as timed out. Throws when merman itself fails rather than refusing the diagram, which
 * leaves its instance unusable.
 */
export function drawDiagram(
  source: string,
  palette: DiagramPalette,
  pictureKind: DiagramPictureKind,
  textMeasurer: HostTextMeasurer,
): DiagramDrawing {
  let svg: string;
  try {
    svg = renderSvgWithTextMeasurer(
      source,
      textMeasurer,
      // The deadline is the transport's own field, outside the options schema, so it is sent in
      // the string form.
      JSON.stringify({
        version: 2,
        site_config: siteConfigurationFor(palette),
        resources: { profile: "interactive" },
        ...(pictureKind === "copied" ? { svg: { pipeline: "resvg-safe" } } : {}),
        timeout_ms: DRAWING_DEADLINE_MS,
      }),
    );
  } catch (error) {
    if (isBindingErrorPayload(error)) {
      // merman cancels a drawing only when its deadline passes.
      return error.code_name === "MERMAN_CANCELLED"
        ? { status: "timed-out" }
        : { status: "settled", outcome: { kind: "failed", reason: firstLineOf(error.message) } };
    }
    throw error;
  }
  return { status: "settled", outcome: pictureOf(svg, palette) };
}

/** The drawing library's message for a failure that is not a refused diagram. */
export function describeLibraryFailure(error: unknown): string {
  return firstLineOf(describeFailure(error));
}

/**
 * The keys a diagram's own front matter and `init` may not change: merman's own secure list, which
 * a site's list replaces rather than joins, then everything the palette and the picture depend on.
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

/**
 * The site configuration. A diagram's own front matter and `init` override it except for the
 * locked keys, so its colors and type stay the screen's; dagre lays a diagram out unless the
 * diagram asks for another layout.
 */
function siteConfigurationFor(palette: DiagramPalette): MermaidSiteConfig {
  const fontSize = `${String(palette.fontSizePx)}px`;
  return {
    secure: [...LOCKED_CONFIGURATION_KEYS],
    // The one theme merman derives wholly from the variables below.
    theme: "base",
    layout: "dagre",
    // Labels as SVG text, which the image draws and the copy's canvas reads alike.
    htmlLabels: false,
    darkMode: palette.isDark,
    fontFamily: palette.fontFamily,
    fontSize: palette.fontSizePx,
    themeVariables: {
      ...palette.colors,
      darkMode: palette.isDark,
      fontFamily: palette.fontFamily,
      fontSize,
    },
  };
}

/** A picture's natural size, in CSS pixels. */
interface PictureSize {
  readonly width: number;
  readonly height: number;
}

/** The height, in CSS pixels, a browser lays out an SVG at when it names no height or view box. */
const UNSIZED_SVG_HEIGHT = 150;

/** The root element's opening tag, and its attributes. */
const SVG_ROOT_TAG = /^(\s*(?:<\?xml[^>]*>\s*)?<svg)(\s[^>]*?)?(\/?>)/u;

/** One attribute of the root tag, by name. */
function attributePattern(name: string): RegExp {
  return new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, "u");
}

/**
 * merman's SVG as a standalone image: sized by its view box rather than the column-wide width and
 * maximum it is drawn with, so the image has a natural size to lay out and copy at.
 */
function pictureOf(svg: string, palette: DiagramPalette): DiagramOutcome {
  const root = SVG_ROOT_TAG.exec(svg);
  const attributes = root?.[2] ?? "";
  const size = viewBoxSizeOf(attributes) ?? unboxedSizeOf(attributes);
  if (root === null || size === undefined) {
    return { kind: "failed", reason: "The drawing has no size" };
  }
  const width = Math.ceil(size.width);
  const height = Math.ceil(size.height);
  const sizedAttributes =
    ["width", "height", "style"].reduce(
      (kept, name) => kept.replace(attributePattern(name), ""),
      attributes,
    ) + ` width="${String(width)}" height="${String(height)}"`;
  return {
    kind: "drawn",
    markup: `${root[1] ?? ""}${sizedAttributes}${root[3] ?? ""}${svg.slice(root[0].length)}`,
    width,
    height,
    groundColor: palette.groundColor,
  };
}

/** The size the root's view box gives, when it has one. */
function viewBoxSizeOf(attributes: string): PictureSize | undefined {
  const viewBox = attributePattern("viewBox").exec(attributes)?.[1]?.slice(1, -1) ?? "";
  const [, , width, height] = viewBox
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  return width !== undefined && width > 0 && height !== undefined && height > 0
    ? { width, height }
    : undefined;
}

/**
 * The size a page draws a root with no view box at, as the info diagram's is: the widest its style
 * allows, and the height a browser gives an SVG that names none.
 */
function unboxedSizeOf(attributes: string): PictureSize | undefined {
  const style = attributePattern("style").exec(attributes)?.[1] ?? "";
  const width = Number(/max-width\s*:\s*([\d.]+)px/u.exec(style)?.[1]);
  return width > 0 ? { width, height: UNSIZED_SVG_HEIGHT } : undefined;
}

/** A message's first line, without the colon that introduces the lines under it. */
function firstLineOf(message: string): string {
  return (message.split("\n")[0] ?? "").trim().replace(/:$/u, "");
}
