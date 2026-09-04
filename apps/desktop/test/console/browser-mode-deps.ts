// The dependency set every browser-mode tier pre-bundles in ONE optimizer pass.
//
// Vite's optimizer keys its pre-bundle on the exact specifier, so listing
// `@base-ui/react` covers the package root and NOTHING else: the console imports
// Base UI through subpath entries (`@base-ui/react/combobox`, …), and a subpath the
// list does not name is discovered lazily — the first time a test renders through
// it — which starts a second optimizer pass. That second pass emits its own
// `react` chunk under a new `?v=` hash, two React module instances share no
// context, and the first Base UI component to call `useContext` reads `null`.
// The failure appears only on a cold optimizer cache, which is every CI run and no
// developer machine that has run the tier once, so it is the shape of defect a
// green local run cannot see.
//
// This module is the one home for the list. `vitest.config.ts` consumes it, and
// `architecture/browser-mode-optimize-deps.test.ts` holds it against the entries
// the source tree actually imports, so a new subpath fails the architecture tier
// before it can fail the browser tiers on a cold cache.

/** The Base UI package root. Subpath entries are `${BASE_UI_PACKAGE}/<part>`. */
export const BASE_UI_PACKAGE = "@base-ui/react";

/**
 * Every Base UI entry point the console imports, root included.
 *
 * Declared, not derived, because the optimizer must know the set before any
 * test file is loaded; the architecture tier derives the imported set from the
 * source tree and refuses a divergence in either direction.
 */
export const BASE_UI_ENTRY_POINTS: readonly string[] = [
  BASE_UI_PACKAGE,
  `${BASE_UI_PACKAGE}/alert-dialog`,
  `${BASE_UI_PACKAGE}/combobox`,
  `${BASE_UI_PACKAGE}/dialog`,
  `${BASE_UI_PACKAGE}/menu`,
  `${BASE_UI_PACKAGE}/radio`,
  `${BASE_UI_PACKAGE}/radio-group`,
  `${BASE_UI_PACKAGE}/switch`,
];

/**
 * Everything a browser-mode tier renders through, pre-bundled together and
 * deduplicated. `dedupe` (declared beside the config) keeps a single React copy
 * resolved from the package root; this list makes one pass see every consumer.
 */
export const BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE: readonly string[] = [
  "react",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  ...BASE_UI_ENTRY_POINTS,
  "@testing-library/react",
  "axe-core",
];
