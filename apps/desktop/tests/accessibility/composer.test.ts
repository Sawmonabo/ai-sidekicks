// The accessibility tier over every view the composer feature mounts, each scoped to itself
// so a violation names the view that owns it, in both schemes for `app-frame.test.ts`'s
// reason. The composer is always on screen while a person types and carries the most controls
// per pixel, and its addresses offer different ones, so a name or label lost on one address is
// invisible on the others.

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { emulateSystemScheme } from "../helpers/media-emulation.js";
import {
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountComposerSessionDefault,
} from "./feature-mounts/composer.js";
import { type MountedView } from "./feature-mounts/queries.js";
import { describeViolations, runTierAxe } from "./axe-run.js";
import { untilInsideAct } from "../helpers/settle.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { COLOR_SCHEMES } from "#renderer/styles/tokens.js";

/** A console command registered for the open list, so it holds a row that runs here. */
const LISTED_COMMAND_ID = "composer-accessibility.act";

/** The views this feature ships, each named as a reader would name it. */
const AUDITED_VIEWS: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedView>;
}[] = [
  { label: "the composer on the session", mount: mountComposerSessionDefault },
  { label: "the composer addressed at a working run", mount: mountComposerProviderBoundRunning },
  { label: "the composer addressed at a waiting run", mount: mountComposerProviderBoundWaiting },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the composer views", () => {
  for (const view of AUDITED_VIEWS) {
    for (const scheme of COLOR_SCHEMES) {
      it(`has no axe violation on ${view.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        const mounted = await view.mount();

        expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
      });
    }
  }
});

describe("accessibility — the composer's command list", () => {
  it("has no axe violation with the list open, its rows holding no control", async () => {
    commandRegistry.register({
      id: LISTED_COMMAND_ID,
      title: "A console act",
      group: "Test",
      run: () => undefined,
    });
    onTestFinished(() => {
      commandRegistry.unregister(LISTED_COMMAND_ID);
    });
    const mounted = await mountComposerProviderBoundRunning();
    const line = mounted.element.querySelector("textarea");
    if (line === null) {
      throw new Error("the composer drew no message line");
    }
    const findConsoleRow = (): Element | undefined =>
      Array.from(mounted.element.querySelectorAll('[role="option"]')).find((option) =>
        option.textContent?.includes(LISTED_COMMAND_ID),
      );
    // Inside `act`, so the list's own reads as it opens are flushed by React rather than reported.
    await untilInsideAct(async () => {
      await userEvent.type(line, "/");
      await expect.poll(findConsoleRow).toBeDefined();
    });

    expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);

    // Negative control: a control put back inside a row is the violation this case guards. It is
    // sized past the smallest target, so the one rule it breaks is the nesting.
    const planted = document.createElement("button");
    planted.type = "button";
    planted.textContent = "Run";
    planted.style.cssText = "min-inline-size: 2rem; min-block-size: 2rem";
    findConsoleRow()?.append(planted);
    const violations = await runTierAxe(mounted.element);
    planted.remove();
    expect(violations.map((violation) => violation.id)).toStrictEqual(["nested-interactive"]);
  });
});
