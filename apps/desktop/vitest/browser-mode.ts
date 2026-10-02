// Browser-mode options shared by the three browser tiers (browser, screenshot, accessibility), so
// they render under the same conditions from one home.

import { playwright, type PlaywrightProviderOptions } from "@vitest/browser-playwright";

/**
 * Conditions that resolve workspace value imports to TS source rather than a stale `dist/`. Every
 * DOM-environment project uses them, because each imports `@ai-sidekicks/contracts` for value.
 */
export const WORKSPACE_SOURCE_CONDITIONS: string[] = ["@ai-sidekicks/source", "import", "default"];

/**
 * The module that loads the renderer's global sheets. A browser-mode tier mounts
 * components without the renderer entry that imports it, so each tier loads it first.
 */
export const BROWSER_MODE_SETUP_FILES: string[] = ["src/renderer/src/styles/global-sheets.ts"];

/** The Base UI package root. Subpath entries are `${BASE_UI_PACKAGE}/<part>`. */
const BASE_UI_PACKAGE = "@base-ui/react";

/**
 * Every Base UI entry point the renderer imports, root included. Declared rather than derived
 * because the optimizer needs the set before any test file loads; a renderer module that imports a
 * new subpath adds its line here.
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
 * Everything a browser-mode tier renders through, pre-bundled in one optimizer pass. Vite keys its
 * pre-bundle on the exact specifier, so a Base UI subpath the list does not name is discovered
 * lazily and starts a second pass. That pass emits a second `react` chunk under a new `?v=` hash,
 * two React instances share no context, and the first Base UI component to call `useContext`
 * reads `null`. This shows only on a cold optimizer cache, which is every CI run.
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
 * The window the renderer is measured in: the smallest common laptop screen. Browser mode's default
 * is a phone viewport, where geometry assertions would measure a layout no person sees and "does
 * not scroll horizontally" would pass because nothing has room to overflow.
 */
export const BROWSER_MODE_VIEWPORT = { width: 1440, height: 900 };

/**
 * Browser-mode settings shared by every tier that renders. It is a factory because Vitest writes a
 * derived name back onto the instance descriptor it is handed: projects spread from one literal
 * share one `instances` array, so the second finds the first's name stamped and the run aborts
 * with "the project name ... was already defined".
 *
 * `screenshotFailures` is off because Vitest would write failure captures into `__screenshots__`,
 * the directory the screenshot tier writes its capture aids into, mixing throwaway PNGs of red
 * tests with the pictures a person came to look at.
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
