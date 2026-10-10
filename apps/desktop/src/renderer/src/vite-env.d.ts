// Ambient declarations for the renderer's bundler imports. The renderer's `tsconfig.json` sets
// `types: []` (no Node types in a browser-context program), so `vite/client` is not pulled in
// wholesale; the module shapes the console imports are declared here instead. The build signals
// every process reads are declared once in `src/shared/`: Vite's own in `development-build.d.ts`,
// the fixture gate in `fixture-build.d.ts`.

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

// A script a window document loads into its own realm, emitted and addressed the same way.
declare module "*.js?url" {
  const assetUrl: string;
  export default assetUrl;
}

// Vite's `?worker` import: the module is bundled as its own script and the default export
// constructs a dedicated worker running it.
declare module "*?worker" {
  const WorkerScript: new () => Worker;
  export default WorkerScript;
}

// Side-effect stylesheet imports (`import "./Chip.css"`), which Vite bundles. TypeScript checks
// that a side-effect import resolves, and a stylesheet has no declarations, so the wildcard says
// every `.css` specifier is a module with no exports.
declare module "*.css" {}

// The one Sass import, `components/Markdown/typesetter.scss`, KaTeX's sheet built from its source,
// which Vite compiles to a stylesheet; like a `.css` import it has no exports.
declare module "*.scss" {}
