// Ambient declarations for the console's build-time environment signals. The renderer's
// `tsconfig.json` sets `types: []` (no Node types in a browser-context program), so `vite/client`
// is not pulled in wholesale; the members the console reads are declared here instead.
//
// `__FIXTURE_BUILD__` is the compile-time fixture gate. The fixture composition, the fixture
// bridge and every scenario sit behind a `define`-substituted identifier so Rollup collapses
// `if (false)` and the bodies are absent from a release bundle; a runtime `process.env` check
// would ship them.

/**
 * `true` only in a build that carries the scenario catalog: the development and fixtures builds.
 * Vite's `define` substitutes it textually before parsing, so it is a literal at build time,
 * never a variable read.
 */
declare const __FIXTURE_BUILD__: boolean;

interface ImportMetaEnv {
  /** Vite's development-mode flag. */
  readonly DEV: boolean;
  /** Vite's production-mode flag. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * A compiled icon face, `~icons/tabler/<name>` or `~icons/signature/<name>`. `unplugin-icons`
 * resolves the specifier at build time and `@svgr` compiles it to a React component that forwards
 * its props onto the root `<svg>`, so a caller sets the size and accessible name (see
 * `vitest/icon-compilation.ts`). No file or `.d.ts` exists for a face, so the shape is declared
 * here.
 */
declare module "~icons/*" {
  const IconFace: import("react").ComponentType<import("react").SVGProps<SVGSVGElement>>;
  export default IconFace;
}

// Vite's `?url` asset imports: the suffix asks the bundler to emit the file and return its URL
// rather than inline its bytes, which an `@font-face` `src` needs. Declared here because
// `types: []` keeps `vite/client` out.
declare module "*.woff2?url" {
  const assetUrl: string;
  export default assetUrl;
}
