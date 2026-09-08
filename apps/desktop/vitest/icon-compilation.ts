// Compile-time icon resolution — one plugin, one weight, three consumers.
//
// `Spec-023 §Console Libraries` admits the Tabler set through `unplugin-icons`
// with our own signature glyphs "in the same collection", compiled at build
// time. This module is the whole of that wiring: `~icons/tabler/<name>` and
// `~icons/signature/<name>` both resolve here, both are compiled to a React
// component by `@svgr`, and both leave carrying the same stroke contract.
//
// WHY ONE MODULE AND NOT THREE BLOCKS. The renderer is compiled in three
// places — `electron.vite.config.ts` builds it, every console Vitest tier
// resolves it, and the root `renderer` project compiles console source for the
// Tier-1 components that reach it — and an icon that resolved in one and not in
// another would fail at import with a specifier no reader could place. Worse,
// three copies of the stroke contract would drift silently: a face is legible
// at any weight, so nothing goes red when one of the three is edited and the
// others are not. So the three consumers call this function and hold no
// options of their own.
//
// THE STROKE CONTRACT, AND WHY IT IS APPLIED HERE RATHER THAN AT THE CALL SITE.
// `tokens/glyphs.ts` rule 1 fixes one geometry for the whole family: stroked at
// `GLYPH_STROKE_WIDTH` in a `GLYPH_VIEWBOX_SIZE` box, round caps and joins,
// never filled. Tabler draws at a 24-unit box and a 2-unit stroke and puts
// those attributes on the DRAWING elements, not on the root `<svg>` — so a root
// attribute cannot override them and `Glyph.tsx` cannot impose the family's
// weight the way it did over hand-authored path strings. Both halves of the fix
// live below: `withoutDrawnPresentation` takes the presentation attributes off
// the body, and `strokeContractFor` puts the family's own back on the root,
// scaled to that collection's box so 1.5 px at 16 px is what a reader sees
// whichever collection the face came from.
//
// BOTH COLLECTIONS ARE CUSTOM COLLECTIONS, and that is load-bearing rather than
// incidental. `unplugin-icons` applies `transform` only to a custom collection
// (measured: `@iconify/utils`' `getCustomIcon` is its only caller), so routing
// Tabler through `ExternalPackageIconLoader` — the loader the plugin publishes
// for exactly this — is what lets one normalization reach both. The signature
// faces arrive through `FileSystemIconLoader` over the directory beside
// `Glyph.tsx`, so adding one is adding a file.

import { fileURLToPath } from "node:url";

import { type Plugin as SvgrPlugin, transform as svgToReactComponent } from "@svgr/core";
import jsxPluginModule from "@svgr/plugin-jsx";
import { ExternalPackageIconLoader, FileSystemIconLoader } from "unplugin-icons/loaders";
import Icons from "unplugin-icons/vite";
import type { Plugin } from "vitest/config";

import {
  GLYPH_STROKE_WIDTH,
  GLYPH_VIEWBOX_SIZE,
} from "../src/renderer/src/console/tokens/glyphs.js";

/**
 * The `@svgr` JSX emitter as a VALUE, with the package's own mis-declaration corrected.
 *
 * `@svgr/plugin-jsx@8.1.0`'s `dist/index.js` ends in `module.exports = jsxPlugin` — a
 * bare CommonJS assignment with no `__esModule` marker — so a default import of it
 * yields the plugin FUNCTION under Node's interop and under a bundler's alike. Its
 * `dist/index.d.ts` declares `export { jsxPlugin as default }` instead, which
 * `nodenext` reads as `module.exports = { default: … }`, a shape the emitted file never
 * has. Read verbatim the value types as the module NAMESPACE, which is the one thing it
 * is not.
 *
 * So the cast is a correction rather than a convenience — and it is checked rather than
 * asserted, because a cast that outlives the fact it rests on is how a package's next
 * release becomes a silent miscompile. A release that moves to `exports.default` fails
 * here, by name, when the config loads.
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
 * The box Tabler draws in.
 *
 * Read from the set rather than assumed: `@iconify-json/tabler@1.2.38` declares
 * `width: 24, height: 24` at the set level and no icon overrides it. It is a
 * constant here because the scale below needs a number before any icon is
 * loaded — `iconCustomizer` is handed a collection and a name and never the
 * icon's own geometry — and `glyph-faces.test.ts` reads the compiled `viewBox`
 * back off every face, so a set that moved its box fails there rather than
 * shipping a family drawn at two weights.
 */
const TABLER_VIEWBOX_SIZE = 24;

/** The directory holding one `.svg` per signature face. */
const SIGNATURE_FACE_DIRECTORY = fileURLToPath(
  new URL("../src/renderer/src/console/primitives/glyph-faces/signature", import.meta.url),
);

/** The box each collection draws in, which is what the stroke scale divides by. */
const COLLECTION_VIEWBOX_SIZES: Readonly<Record<string, number>> = {
  [SIGNATURE_ICON_COLLECTION]: GLYPH_VIEWBOX_SIZE,
  tabler: TABLER_VIEWBOX_SIZE,
};

/**
 * The presentation attributes the family owns, wherever an icon set put them.
 *
 * All five INHERIT, which is why taking them off the body works at all: a
 * `<path>` with none of them draws with whatever the root `<svg>` declares.
 * `fill` is on the list for rule 1's sake — a face that fills reads heavier
 * than its neighbours at 16 px, so stripping it is the enforcement of that rule
 * rather than a formatting preference.
 */
const DRAWN_PRESENTATION_ATTRIBUTE =
  /\s(?:fill|stroke|stroke-width|stroke-linecap|stroke-linejoin)="[^"]*"/g;

/**
 * The same SVG with the drawing elements' presentation attributes removed.
 *
 * Only the body is touched: the root tag is sliced off first and put back
 * unchanged, because that is where {@link strokeContractFor}'s answer lands and
 * stripping it there would leave the face with no weight at all.
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
 * The family's geometry as root attributes, for one collection's box.
 *
 * The stroke width is a RATIO carried across boxes rather than a number per
 * collection: `GLYPH_STROKE_WIDTH` units in a `GLYPH_VIEWBOX_SIZE` box is the
 * same rendered weight as that ratio's share of any other box, so tightening
 * the family is one edit in `tokens/glyphs.ts` and both collections follow.
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
 * One loaded SVG, compiled to a React component by `@svgr`.
 *
 * THE OPTIONS ARE `unplugin-icons`' OWN, and the difference is one line: the
 * plugin's built-in `compiler: "jsx"` names `@svgr/plugin-jsx` as a STRING that
 * `@svgr/core` then resolves with a bare `require` at build time, and this
 * passes the imported plugin as a VALUE. Two things follow, and both are why the
 * indirection is taken rather than the option:
 *
 *   • The dependency becomes visible. `@svgr/plugin-jsx` is a peer of nothing —
 *     it is reached only through that string — so under a name-resolved
 *     reference the dead-code gate reports it unused, and `apps/desktop/
 *     AGENTS.md` admits no `ignoreDependencies` entry to say otherwise. An
 *     import is the honest answer to "is this dependency used": it is, and now
 *     the compiler checks it.
 *   • The resolution stops depending on the installer's layout. A bare `require`
 *     from inside `@svgr/core` finds this plugin only because pnpm hoists the
 *     store into a directory Node's ancestor walk happens to cross; nothing in
 *     either package declares that edge.
 *
 * `raw` was rejected outright for a different reason: it hands back a string a
 * caller can only render through `dangerouslySetInnerHTML`.
 */
async function compileFaceToReactComponent(
  svg: string,
  collection: string,
  iconName: string,
): Promise<string> {
  return svgToReactComponent(
    svg,
    { plugins: [SVGR_JSX_PLUGIN], ref: true, titleProp: true },
    { componentName: faceComponentName(collection, iconName) },
  );
}

/**
 * The `~icons/*` resolver, compiled to React components at build time.
 *
 * Called once per consuming configuration rather than shared as a value: a Vite
 * plugin instance belongs to the config that installs it, and three projects
 * sharing one object would share whatever state the plugin caches per build.
 */
export function iconCompilationPlugin(): Plugin | Plugin[] {
  return Icons({
    // `Spec-023 §Console Libraries`' own row names the `@svgr` path, and this is
    // it — see the compiler above for the one respect in which it is spelled out
    // rather than named. `extension` is what makes the resolved specifier end in
    // `.jsx`, so the bundler applies its JSX transform to what comes back.
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
