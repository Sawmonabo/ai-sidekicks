// A `sidekicks://` link reaches the console document through the real main, preload and bridge,
// parsed: one the running app is handed through the platform's own event (`open-url` on macOS, a
// second launch's command line elsewhere), held until the console document subscribes and pushed
// after, and one on the command line the app was launched with. A link main's parser refuses
// reaches the document as nothing.

import type { ElectronApplication, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { composeAppLink } from "@ai-sidekicks/contracts/app-link";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { NavigationRequest, PreloadApi } from "#shared/preload-api.js";
import { type AppUnderTest, withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

const SECOND_SESSION_ID = "0199a0c2-7d3e-7b1f-9c4a-8f3a1b2c5d6f" as SessionId;
const FIRST_SESSION: NavigationRequest = {
  kind: "session",
  sessionId: "0199a0c2-7d3e-7b1f-9c4a-8f3a1b2c5d6e" as SessionId,
};
const SECOND_SESSION: NavigationRequest = { kind: "session", sessionId: SECOND_SESSION_ID };

/** The console document's own record of what its subscription heard, on its global object. */
interface HeardRequests {
  navigationRequestsHeard: NavigationRequest[];
}

/** Hands the running app `address` as the platform hands a link to an app already running. */
async function handOverLink(application: ElectronApplication, address: string): Promise<void> {
  await application.evaluate(({ app }, link) => {
    if (process.platform === "darwin") {
      app.emit("open-url", { preventDefault() {} }, link);
    } else {
      app.emit(
        "second-instance",
        { preventDefault() {} },
        [process.execPath, link],
        process.cwd(),
        {},
      );
    }
  }, address);
}

/** Subscribes the console document to main's navigation requests, recording each one it hears. */
async function subscribeConsoleDocument(consolePage: Page): Promise<void> {
  await consolePage.evaluate(() => {
    const heard: NavigationRequest[] = [];
    (window as unknown as HeardRequests).navigationRequestsHeard = heard;
    (
      window as unknown as { desktopBridge: PreloadApi }
    ).desktopBridge.window.subscribeToNavigationRequest((request) => heard.push(request));
  });
}

/** Waits until the console document has heard exactly `expected`, in order. */
async function expectHeard(
  appUnderTest: AppUnderTest,
  expected: readonly NavigationRequest[],
): Promise<void> {
  await expect
    .poll(
      async () =>
        await appUnderTest.consolePage.evaluate(
          () => (window as unknown as HeardRequests).navigationRequestsHeard,
        ),
      {
        timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        message: "the console document did not hear the requests main was handed",
      },
    )
    .toEqual(expected);
}

describe.skipIf(!bundleIsBuilt)("end-to-end — a sidekicks:// link", () => {
  it("reaches the console document parsed, held until it subscribes, and a malformed one as nothing", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      await handOverLink(appUnderTest.application, composeAppLink(FIRST_SESSION));
      await subscribeConsoleDocument(appUnderTest.consolePage);
      await expectHeard(appUnderTest, [FIRST_SESSION]);

      // An empty leading segment, refused at the parser, ahead of a link that parses: pushes keep
      // their order, so a malformed link routed as anything would be heard first.
      await handOverLink(appUnderTest.application, `sidekicks://session//${SECOND_SESSION_ID}`);
      await handOverLink(appUnderTest.application, composeAppLink(SECOND_SESSION));
      await expectHeard(appUnderTest, [FIRST_SESSION, SECOND_SESSION]);
    });
  });

  it("hands over the link the app was launched with once the console document subscribes", async () => {
    await withLaunchedApp({ appLink: composeAppLink(FIRST_SESSION) }, async (appUnderTest) => {
      await subscribeConsoleDocument(appUnderTest.consolePage);
      await expectHeard(appUnderTest, [FIRST_SESSION]);
    });
  });
});
