// The browser-mode options every console browser tier shares.
//
// Lifted out of `vitest.config.ts` when that file passed the package's ceiling, and
// the seam is the one the file already had: these are values SEVERAL projects read,
// while everything left behind is one project's own declaration. `Spec-023 §Console
// Test Tiers` names four projects that run in a browser and they must render under
// the same conditions, which is a property that survives only while the conditions
// have one home.

import { playwright, type PlaywrightProviderOptions } from "@vitest/browser-playwright";

import { BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE } from "../test/console/browser-mode-deps.js";

/**
 * Conditions that resolve workspace *value* imports to TS source rather than a
 * stale `dist/`. Shared by every DOM-environment project, because each of them
 * imports `@ai-sidekicks/contracts` for value as well as type.
 */
export const WORKSPACE_SOURCE_CONDITIONS = ["@ai-sidekicks/source", "import", "default"];

/**
 * Everything a browser-mode tier renders through, pre-bundled in ONE optimizer
 * pass and deduplicated. The list lives in `test/console/browser-mode-deps.ts`
 * so the architecture tier can hold it against the Base UI entries the source
 * tree imports: the optimizer keys on the exact specifier, so a subpath the list
 * does not name is discovered lazily on a cold cache, starts a second pass, and
 * leaves the tier with two React copies — the first Base UI `useContext` then
 * reads `null` and the whole tree fails to render.
 */
export const BROWSER_MODE_OPTIMIZE_DEPS = { include: [...BROWSER_MODE_OPTIMIZE_DEPS_INCLUDE] };

/** The one React copy every browser-mode tier resolves. */
export const BROWSER_MODE_DEDUPE = ["react", "react-dom"];

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
