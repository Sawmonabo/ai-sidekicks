// The browser-mode optimizer list names every Base UI entry the console imports.
//
// A Base UI subpath the optimizer list does not name is discovered on first
// render, starts a second optimizer pass, and leaves the tier with two React
// copies — a failure that shows only on a cold cache (every CI run) and never on
// a machine that has run the tier once. The list therefore has to be held against
// the source tree by something that runs on every tree, cache or no cache: this
// tier reads the import specifiers under `src/` and refuses a divergence in
// either direction. An entry the tree no longer imports is a stale pre-bundle
// that costs optimizer time for nothing, so it is refused too.
//
// The derivation reads source text rather than resolving modules because the
// question is "which specifiers will Vite see", and Vite sees the text.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";

import {
  BASE_UI_ENTRY_POINTS,
  BASE_UI_PACKAGE,
  BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE,
} from "../browser-mode-deps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(HERE, "..", "..", "..", "src");

/** Every `from "<BASE_UI_PACKAGE>…"` specifier a source file names, exactly. */
const BASE_UI_IMPORT_PATTERN = new RegExp(
  `from\\s+["'](${BASE_UI_PACKAGE.replaceAll("/", "\\/")}(?:\\/[^"']+)?)["']`,
  "g",
);

/**
 * Every Base UI entry point the tree under `rootDirectory` imports.
 *
 * The module set comes from `test/console/console-source-modules.ts`, which is the one
 * walk under every source-text claim in this tier. It used to be a `globSync` here with
 * its own idea of what counts as source — declaration files included, which the shared
 * walk excludes because nothing in one runs — and that is exactly the sixth opinion the
 * source-walk chokepoint next door exists to refuse. `{ tests: true }` keeps the
 * universe this derivation always had: a specifier Vite will see is a specifier Vite
 * will see whether the file importing it is a test or not.
 */
function baseUiEntryPointsImportedUnder(rootDirectory: string): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const module of consoleSourceModules({ roots: [rootDirectory], tests: true })) {
    for (const match of readConsoleSourceModule(module).matchAll(BASE_UI_IMPORT_PATTERN)) {
      imported.add(match[1] as string);
    }
  }
  return imported;
}

describe("browser-mode optimizer — the base-ui entries the console imports", () => {
  const imported = baseUiEntryPointsImportedUnder(SOURCE_ROOT);

  it("names every base-ui entry point the source tree imports", () => {
    const declared = new Set(BASE_UI_ENTRY_POINTS);
    const undeclared = [...imported].filter((entry) => !declared.has(entry)).sort();
    expect(undeclared).toEqual([]);
  });

  it("names no base-ui entry point the source tree has stopped importing", () => {
    const stale = BASE_UI_ENTRY_POINTS.filter(
      (entry) => entry !== BASE_UI_PACKAGE && !imported.has(entry),
    ).sort();
    expect(stale).toEqual([]);
  });

  it("carries every entry point into the optimizer include list", () => {
    for (const entry of BASE_UI_ENTRY_POINTS) {
      expect(BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE).toContain(entry);
    }
  });

  it("negative control: a subpath the list does not name is caught by the derivation", () => {
    const planted = `${BASE_UI_PACKAGE}/menu`;
    const source = `import { Menu } from "${planted}";\n`;
    const seen = [...source.matchAll(BASE_UI_IMPORT_PATTERN)].map((match) => match[1]);
    expect(seen).toEqual([planted]);
    expect(BASE_UI_ENTRY_POINTS).not.toContain(planted);
  });

  it("negative control: the source tree really does import a subpath (the derivation is not vacuous)", () => {
    expect(imported.size).toBeGreaterThan(0);
    expect([...imported].some((entry) => entry.startsWith(`${BASE_UI_PACKAGE}/`))).toBe(true);
  });
});
