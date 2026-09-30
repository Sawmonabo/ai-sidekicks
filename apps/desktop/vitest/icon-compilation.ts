// Compile-time icon resolution, one plugin for every consumer. `~icons/tabler/<name>` and
// `~icons/signature/<name>` both resolve here, are compiled to a React component by `@svgr`, and
// leave with the same stroke contract.
//
// The renderer is compiled by the build (`electron.vite.config.ts`) and by every Vitest tier
// (`tier-projects.ts`), and both call this function with no options of their own. An icon that
// resolved in one and not the other would fail at import with an unplaceable specifier, and two
// copies of the stroke contract would drift silently, since a face is legible at any weight.
//
// The stroke contract is applied here, not at the call site. `styles/glyphs.ts` fixes one
// geometry for the family: stroked at `GLYPH_STROKE_WIDTH` in a `GLYPH_VIEWBOX_SIZE` box, round
// caps and joins, never filled. Tabler draws in a 24-unit box with a 2-unit stroke and puts those
// attributes on the drawing elements, not the root `<svg>`, so a root attribute cannot override
// them. `withoutDrawnPresentation` removes them from the body and `strokeContractFor` puts the
// family's own on the root, scaled to the collection's box so the rendered weight matches.
//
// Both collections are custom collections on purpose: `unplugin-icons` applies `transform` only to
// a custom collection (measured: `@iconify/utils`' `getCustomIcon` is its only caller), so loading
// Tabler through `ExternalPackageIconLoader` lets one normalization reach both. Signature faces
// load through `FileSystemIconLoader` over `src/renderer/src/assets/icons/signature`, so adding
// one is adding a file.

import { fileURLToPath } from "node:url";

import { type Plugin as SvgrPlugin, transform as svgToReactComponent } from "@svgr/core";
import jsxPluginModule from "@svgr/plugin-jsx";
import { ExternalPackageIconLoader, FileSystemIconLoader } from "unplugin-icons/loaders";
import Icons from "unplugin-icons/vite";
import type { Plugin } from "vitest/config";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEWBOX_SIZE } from "../src/renderer/src/styles/glyphs.js";

/**
 * The `@svgr` JSX emitter as a value, correcting the package's mis-declaration.
 * `@svgr/plugin-jsx@8.1.0` ends in `module.exports = jsxPlugin` with no `__esModule` marker, so a
 * default import yields the function, but its `index.d.ts` declares `export { jsxPlugin as
 * default }`, which `nodenext` types as the module namespace. The cast is checked when the config
 * loads, so a release that moves to `exports.default` fails here, by name.
 */
function resolveSvgrJsxPlugin(): SvgrPlugin {
  if (typeof jsxPluginModule !== "function") {
    throw new TypeError(
      "`@svgr/plugin-jsx` no longer default-exports its plugin function, so the icon " +
        "compiler cannot pass it by value. Read the package's current export shape and " +
        "pass whatever it exports now — never the plugin's NAME, which `@svgr/core` " +
        "resolves with a bare require that only the installer's layout satisfies.",
    );
  }
  return jsxPluginModule as SvgrPlugin;
}

/** The emitter every face is compiled by, resolved once when the config loads. */
const SVGR_JSX_PLUGIN: SvgrPlugin = resolveSvgrJsxPlugin();

/** The collection name our own faces answer to: `~icons/signature/<name>`. */
const SIGNATURE_ICON_COLLECTION = "signature";

/** The Iconify package the borrowed half of the family is drawn from. */
const TABLER_ICON_PACKAGE = "@iconify-json/tabler";

/**
 * The box Tabler draws in: `@iconify-json/tabler@1.2.38` declares `width: 24, height: 24` at the
 * set level and no icon overrides it. It is a constant because the scale needs a number before any
 * icon loads (`iconCustomizer` is given a collection and a name, never the icon's geometry).
 */
const TABLER_VIEWBOX_SIZE = 24;

/** The directory holding one `.svg` per signature face. */
const SIGNATURE_FACE_DIRECTORY = fileURLToPath(
  new URL("../src/renderer/src/assets/icons/signature", import.meta.url),
);

/** The box each collection draws in, which is what the stroke scale divides by. */
const COLLECTION_VIEWBOX_SIZES: Readonly<Record<string, number>> = {
  [SIGNATURE_ICON_COLLECTION]: GLYPH_VIEWBOX_SIZE,
  tabler: TABLER_VIEWBOX_SIZE,
};

/**
 * The presentation attributes the family owns, wherever an icon set put them. All five inherit,
 * so a `<path>` with none draws with whatever the root `<svg>` declares. `fill` is listed because
 * a filled face reads heavier than its neighbors at 16 px.
 */
const DRAWN_PRESENTATION_ATTRIBUTE =
  /\s(?:fill|stroke|stroke-width|stroke-linecap|stroke-linejoin)="[^"]*"/g;

/**
 * The SVG with the drawing elements' presentation attributes removed. The root tag is kept
 * unchanged, because {@link strokeContractFor}'s answer lands there.
 */
function withoutDrawnPresentation(svg: string): string {
  const rootTagEnd = svg.indexOf(">");
  if (rootTagEnd < 0) {
    return svg;
  }
  const rootTag = svg.slice(0, rootTagEnd + 1);
  const body = svg.slice(rootTagEnd + 1);
  return `${rootTag}${body.replace(DRAWN_PRESENTATION_ATTRIBUTE, "")}`;
}

/**
 * The family's geometry as root attributes for one collection's box. The stroke width is a ratio
 * carried across boxes, so tightening the family is one edit in `styles/glyphs.ts`.
 */
function strokeContractFor(collection: string, iconName: string): Record<string, string> {
  const viewBoxSize = COLLECTION_VIEWBOX_SIZES[collection];
  if (viewBoxSize === undefined) {
    throw new Error(
      `The console draws no icons from "${collection}" (asked for "${iconName}"). ` +
        `Add the collection's own viewBox size beside the ones the console already draws.`,
    );
  }
  return {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": String((GLYPH_STROKE_WIDTH * viewBoxSize) / GLYPH_VIEWBOX_SIZE),
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
}

/** A generated component's own identifier, which only a stack trace ever shows. */
function faceComponentName(collection: string, iconName: string): string {
  const words = `${collection}-${iconName}`.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join("");
}

/**
 * One loaded SVG compiled to a React component by `@svgr`. The imported plugin is passed as a
 * value, not by the string `compiler: "jsx"` uses, which `@svgr/core` resolves with a bare
 * `require`. That makes the dependency visible to the dead-code gate, which would report
 * `@svgr/plugin-jsx` unused when reached only through a string (the gate admits no
 * dependency exemption), and it stops resolution depending on pnpm's hoisted layout. `raw` was
 * rejected because it can only be rendered through `dangerouslySetInnerHTML`.
 *
 * `ref` and `titleProp` are left off: they add a `forwardRef` wrapper and a `title` prop with
 * `aria-labelledby` to every face, and `Glyph.tsx` uses neither, naming a glyph through
 * `aria-label`.
 */
async function compileFaceToReactComponent(
  svg: string,
  collection: string,
  iconName: string,
): Promise<string> {
  return svgToReactComponent(
    svg,
    { plugins: [SVGR_JSX_PLUGIN] },
    { componentName: faceComponentName(collection, iconName) },
  );
}

/**
 * The `~icons/*` resolver, compiled to React components at build time. It is called once per
 * consuming configuration: a Vite plugin instance belongs to the config that installs it, and
 * projects sharing one object would share whatever state it caches.
 */
export function iconCompilationPlugin(): Plugin | Plugin[] {
  return Icons({
    // `extension` makes the resolved specifier end in `.jsx`, so the bundler applies its JSX
    // transform to what comes back.
    compiler: { compiler: compileFaceToReactComponent, extension: "jsx" },
    customCollections: {
      ...ExternalPackageIconLoader(TABLER_ICON_PACKAGE),
      [SIGNATURE_ICON_COLLECTION]: FileSystemIconLoader(SIGNATURE_FACE_DIRECTORY),
    },
    transform: withoutDrawnPresentation,
    iconCustomizer: (collection, iconName, props) => {
      Object.assign(props, strokeContractFor(collection, iconName));
    },
  });
}
