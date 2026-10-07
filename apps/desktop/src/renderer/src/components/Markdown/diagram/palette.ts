// The colors and type a diagram's picture is drawn with, taken from the theme's own color table,
// the source the token sheet is emitted from, and resolved to `#rrggbb`: the drawing library bakes
// colors into the picture through color math that reads neither `oklch()` nor `var()`. Each
// document keeps one palette current from what its root carries (the theme, the scheme it is
// drawn in and the root font size), so every diagram in a window shares one root observer.

import { getWindow } from "@floating-ui/utils/dom";

import {
  DEFAULT_APPEARANCE_RECORD,
  RESOLVED_SCHEME_ATTRIBUTE,
  THEME_ATTRIBUTE,
} from "#shared/appearance.js";
import { COLOR_SCHEMES, type ColorScheme } from "#shared/color-scheme.js";
import { formatSrgbHex, oklchToSrgb, resolveEmittedColor } from "#shared/color.js";
import type { ColorRole } from "#shared/theme/palette.js";
import { APPEARANCE_THEMES, THEME_PALETTES, type AppearanceTheme } from "#shared/theme/registry.js";
import { scaleStep } from "#renderer/styles/palette.js";
import { FONT_STACKS, TYPE_SCALE_REM } from "#renderer/styles/typography.js";

/** Everything one diagram's picture is drawn with. */
export interface DiagramPalette {
  /** Changes exactly when anything below changes, so it keys a drawn picture. */
  readonly identity: string;
  /** Whether the scheme is dark, which the drawing library derives its shades by. */
  readonly isDark: boolean;
  /** The ground the picture sits on, `#rrggbb`. */
  readonly groundColor: string;
  /** The label font: a stack a picture shown as an image can draw with. */
  readonly fontFamily: string;
  /** The label size, in CSS pixels: the size a reply is read at. */
  readonly fontSizePx: number;
  /** The drawing library's theme colors by its own names, each `#rrggbb`. */
  readonly colors: Readonly<Record<string, string>>;
}

/**
 * Keeps the palette one document's diagrams are drawn with current. It watches the root for the
 * theme, the scheme and the text size for the document's lifetime, and hands out the same object
 * until one of them changes, so a read is a stable snapshot.
 */
export class DiagramPaletteWatch {
  readonly #ownerWindow: Window;
  readonly #listeners = new Set<() => void>();
  #palette: DiagramPalette;

  /** Reads the root now and watches it from here on. */
  public constructor(ownerWindow: Window) {
    this.#ownerWindow = ownerWindow;
    this.#palette = composeDiagramPalette(ownerWindow);
    const root = ownerWindow.document.documentElement;
    // The root's own window, whose observer belongs to the document it is in.
    new (getWindow(root).MutationObserver)(() => {
      this.#refresh();
    }).observe(root, {
      attributes: true,
      // The text size is the root's inline font size.
      attributeFilter: [THEME_ATTRIBUTE, RESOLVED_SCHEME_ATTRIBUTE, "style"],
    });
    // A root naming no scheme is drawn in the platform's, which changes with no root write.
    ownerWindow.matchMedia(DARK_SCHEME_QUERY).addEventListener("change", () => {
      this.#refresh();
    });
  }

  /** The palette in force now; the same object until something it is drawn with changes. */
  public read(): DiagramPalette {
    return this.#palette;
  }

  /** Be told each time the palette changes. */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #refresh(): void {
    const next = composeDiagramPalette(this.#ownerWindow);
    if (next.identity === this.#palette.identity) {
      return;
    }
    this.#palette = next;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** The palette watch for the document `ownerWindow` shows, made on first ask and kept with it. */
export function watchDiagramPalette(ownerWindow: Window): DiagramPaletteWatch {
  return diagramPaletteWatches.watchFor(ownerWindow);
}

/** The query the token sheet follows when the root names no scheme. */
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** The role a picture's ground is painted with, the ground of the frame it sits in. */
const PICTURE_GROUND_ROLE: ColorRole = "surface";

/** Which theme role paints each of the drawing library's colors. */
const DRAWING_COLOR_ROLES: Readonly<Record<string, ColorRole>> = {
  background: PICTURE_GROUND_ROLE,
  mainBkg: "surface-sunken",
  primaryColor: "surface-sunken",
  primaryTextColor: "text",
  primaryBorderColor: "edge-strong",
  secondaryColor: "surface-raised",
  secondaryTextColor: "text",
  secondaryBorderColor: "edge-strong",
  tertiaryColor: "surface",
  tertiaryTextColor: "text",
  tertiaryBorderColor: "edge",
  nodeBorder: "edge-strong",
  lineColor: "text-faint",
  textColor: "text",
  titleColor: "text",
  edgeLabelBackground: "surface",
  clusterBkg: "surface-raised",
  clusterBorder: "edge",
  noteBkgColor: "surface-raised",
  noteTextColor: "text",
  noteBorderColor: "edge-strong",
};

/** One palette watch per document, held weakly so a closed window's goes with it. */
class DiagramPaletteWatches {
  readonly #watchesByDocument = new WeakMap<Document, DiagramPaletteWatch>();

  public watchFor(ownerWindow: Window): DiagramPaletteWatch {
    let watch = this.#watchesByDocument.get(ownerWindow.document);
    if (watch === undefined) {
      watch = new DiagramPaletteWatch(ownerWindow);
      this.#watchesByDocument.set(ownerWindow.document, watch);
    }
    return watch;
  }
}

const diagramPaletteWatches = new DiagramPaletteWatches();

/**
 * The label font. The token stack names the self-hosted face first, and a picture shown as an
 * image is its own document, which cannot reach the page's faces; the platform faces after it are
 * the ones the measuring page and the image both draw with, so measured labels fit their boxes.
 */
function readPictureFontFamily(): string {
  const sansStack = FONT_STACKS["font-sans"];
  if (sansStack === undefined) {
    throw new RangeError("the token set names no font-sans stack");
  }
  return sansStack.split(",").slice(1).join(",").trim();
}

const PICTURE_FONT_FAMILY = readPictureFontFamily();

/**
 * The palette for what the root carries now. Each value is read as the token sheet reads it: an
 * absent or unknown theme is the default theme, and an absent scheme is the platform's.
 */
function composeDiagramPalette(ownerWindow: Window): DiagramPalette {
  const root = ownerWindow.document.documentElement;
  const theme = readTheme(root.getAttribute(THEME_ATTRIBUTE));
  const scheme = readScheme(root.getAttribute(RESOLVED_SCHEME_ATTRIBUTE), ownerWindow);
  const rootFontSizePx = Number.parseFloat(ownerWindow.getComputedStyle(root).fontSize);
  const themeColors = THEME_PALETTES[theme].colors;
  const hexOf = (role: ColorRole): string =>
    formatSrgbHex(oklchToSrgb(resolveEmittedColor(themeColors[role][scheme])));
  return {
    identity: `${theme}|${scheme}|${String(rootFontSizePx)}`,
    isDark: scheme === "dark",
    groundColor: hexOf(PICTURE_GROUND_ROLE),
    fontFamily: PICTURE_FONT_FAMILY,
    fontSizePx: scaleStep(TYPE_SCALE_REM, "text-sm") * rootFontSizePx,
    colors: Object.fromEntries(
      Object.entries(DRAWING_COLOR_ROLES).map(([name, role]) => [name, hexOf(role)]),
    ),
  };
}

function readTheme(attribute: string | null): AppearanceTheme {
  return APPEARANCE_THEMES.find((theme) => theme === attribute) ?? DEFAULT_APPEARANCE_RECORD.theme;
}

function readScheme(attribute: string | null, ownerWindow: Window): ColorScheme {
  return (
    COLOR_SCHEMES.find((scheme) => scheme === attribute) ??
    (ownerWindow.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light")
  );
}
