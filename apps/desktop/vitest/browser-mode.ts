// The browser-mode options every console browser tier shares.
//
// Lifted out of `vitest.config.ts` when that file passed the package's ceiling, and
// the seam is the one the file already had: these are values SEVERAL projects read,
// while everything left behind is one project's own declaration. `Spec-023 §Console
// Test Tiers` names four projects that run in a browser and they must render under
// the same conditions, which is a property that survives only while the conditions
// have one home.

import { playwright, type PlaywrightProviderOptions } from "@vitest/browser-playwright";

/**
 * Conditions that resolve workspace *value* imports to TS source rather than a
 * stale `dist/`. Shared by every DOM-environment project, because each of them
 * imports `@ai-sidekicks/contracts` for value as well as type.
 */
export const WORKSPACE_SOURCE_CONDITIONS: string[] = ["@ai-sidekicks/source", "import", "default"];

/** The Base UI package root. Subpath entries are `${BASE_UI_PACKAGE}/<part>`. */
const BASE_UI_PACKAGE = "@base-ui/react";

/**
 * Every Base UI entry point the console imports, root included.
 *
 * Declared rather than derived, because the optimizer must know the set before any
 * test file is loaded. Keeping it current is a reviewer's job: a console module that
 * imports a Base UI subpath adds its line here in the same change.
 */
const BASE_UI_ENTRY_POINTS: readonly string[] = [
  BASE_UI_PACKAGE,
  `${BASE_UI_PACKAGE}/alert-dialog`,
  `${BASE_UI_PACKAGE}/checkbox`,
  `${BASE_UI_PACKAGE}/collapsible`,
  `${BASE_UI_PACKAGE}/combobox`,
  `${BASE_UI_PACKAGE}/dialog`,
  `${BASE_UI_PACKAGE}/menu`,
  `${BASE_UI_PACKAGE}/popover`,
  `${BASE_UI_PACKAGE}/radio-group`,
  `${BASE_UI_PACKAGE}/radio`,
  `${BASE_UI_PACKAGE}/select`,
  `${BASE_UI_PACKAGE}/switch`,
  `${BASE_UI_PACKAGE}/tooltip`,
];

/**
 * Everything a browser-mode tier renders through, pre-bundled in ONE optimizer
 * pass and deduplicated.
 *
 * Vite's optimizer keys its pre-bundle on the exact specifier, so listing
 * `@base-ui/react` covers the package root and NOTHING else: a subpath the list
 * does not name is discovered lazily — the first time a test renders through it —
 * which starts a second optimizer pass. That second pass emits its own `react`
 * chunk under a new `?v=` hash, two React module instances share no context, and
 * the first Base UI component to call `useContext` reads `null`. The failure
 * appears only on a cold optimizer cache, which is every CI run and no developer
 * machine that has run the tier once.
 */
export const BROWSER_MODE_OPTIMIZE_DEPS: { include: string[] } = {
  include: [
    "react",
    "react/jsx-dev-runtime",
    "react-dom",
    "react-dom/client",
    ...BASE_UI_ENTRY_POINTS,
    "@testing-library/react",
    "axe-core",
  ],
};

/** The one React copy every browser-mode tier resolves. */
export const BROWSER_MODE_DEDUPE: string[] = ["react", "react-dom"];

/**
 * The window the console is measured in.
 *
 * Vitest browser mode defaults to a 414×896 phone viewport. The console is a
 * desktop application whose frame is a 52 px rail beside a surface, so at 414 px
 * the surface is 362 px wide — every geometry assertion measures a layout no
 * person will ever see, "does not scroll horizontally" passes because nothing has
 * room to overflow, and a screenshot baseline is a phone-shaped thumbnail. 1440×900
 * is the smallest common laptop, which is the honest floor to hold the budgets at:
 * a baseline captured at the widest window would hide exactly the crowding that
 * shows up first at the narrowest one.
 */
export const BROWSER_MODE_VIEWPORT = { width: 1440, height: 900 };

/**
 * Browser-mode settings shared by every console tier that renders.
 *
 * A FACTORY, not a shared constant, and that is not a style choice. Vitest resolves
 * each browser project by writing a derived name back onto the instance descriptor
 * it was handed; three projects spread from one object literal share one `instances`
 * array, so the second project finds the first one's name already stamped on it and
 * the whole run aborts with "the project name `console-browser (chromium)` was
 * already defined". A fresh object per project is what keeps them independent.
 *
 * `screenshotFailures` is OFF deliberately. Vitest writes a failure capture into
 * `__screenshots__` beside the test file — the same directory `toMatchScreenshot`
 * keeps its committed baselines in — so leaving it on makes that directory mean two
 * different things and puts throwaway PNGs of red tests next to references a review
 * is supposed to read. The screenshot tier still writes its own actual/diff pair on
 * a mismatch, which is the capture that is worth having.
 */
export function browserModeOptions(providerOptions?: PlaywrightProviderOptions): {
  enabled: true;
  provider: ReturnType<typeof playwright>;
  headless: true;
  screenshotFailures: false;
  viewport: { width: number; height: number };
  instances: [{ browser: "chromium" }];
} {
  return {
    enabled: true,
    provider: playwright(providerOptions),
    headless: true,
    screenshotFailures: false,
    viewport: { ...BROWSER_MODE_VIEWPORT },
    instances: [{ browser: "chromium" }],
  };
}
