// Where the overlay scrollbar library's browser bundle is, for the renderer build and every Vitest
// tier. The renderer loads the bundle into each window as a script of its own, by the URL it
// imports with `?url`, but the package's export map names no such subpath, so the exact specifier
// is aliased to the file beside the package's `package.json`, which the map does export. The
// build (`electron.vite.config.ts`) and the tiers (`tier-projects.ts`) install this one plugin, so
// the bundle cannot resolve in one and not the other.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { Plugin } from "vitest/config";

/** The specifier the renderer imports the bundle's URL by. */
const BUNDLE_SPECIFIER = "overlayscrollbars/browser/overlayscrollbars.browser.es6.min.js";

/** The installed bundle, found through the package's exported `package.json`. */
const BUNDLE_PATH = join(
  dirname(createRequire(import.meta.url).resolve("overlayscrollbars/package.json")),
  "browser",
  "overlayscrollbars.browser.es6.min.js",
);

/**
 * Resolves the library's browser bundle specifier, with or without a query such as `?url`, to the
 * installed file. A fresh plugin per config, since a Vite plugin belongs to the config that
 * installs it.
 */
export function overlayScrollbarBundlePlugin(): Plugin {
  return {
    name: "overlay-scrollbar-bundle",
    config: () => ({
      // The renderer imports nothing from the package as a module, only the bundle's URL and its
      // sheet; pre-bundled, the aliased file would be served as a module with no URL to export.
      optimizeDeps: { exclude: ["overlayscrollbars"] },
      resolve: {
        alias: [
          {
            find: new RegExp(`^${BUNDLE_SPECIFIER.replaceAll(".", "\\.")}(?=\\?|$)`),
            replacement: BUNDLE_PATH,
          },
        ],
      },
    }),
  };
}
