// The machine's region and its 12- or 24-hour clock reach the console document's bridge as main
// read them off macOS: a Mac set to the United States with 24-Hour Time on reports `h23` under a
// US English UI language, whose own clock is 12-hour. The setting is the launch's own, through
// Cocoa's argument domain, so the machine's settings never change.

import { describe, expect, it } from "vitest";

import type { AppFacts } from "#shared/app-facts.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt || process.platform !== "darwin")(
  "end-to-end — the machine's clock on the bridge",
  () => {
    it("carries the 24-hour switch a US English Mac is set to, apart from its UI language", async () => {
      await withLaunchedApp(
        { macUserDefaults: { AppleLocale: "en_US@hours=h23", AppleLanguages: "(en-US)" } },
        async (appUnderTest) => {
          const facts = await appUnderTest.consolePage.evaluate(
            (): AppFacts => (window as unknown as { desktopBridge: PreloadApi }).desktopBridge.app,
          );

          expect(facts.locale).toBe("en-US");
          expect(facts.regionLocale).toBe("en-US");
          expect(facts.hourCycle).toBe("h23");
        },
      );
    });
  },
);
