// The accessibility tier over every view the composer feature mounts, each scoped to itself
// so a violation names the view that owns it, in both schemes for `app-frame.test.ts`'s
// reason. The composer is always on screen while a person types and carries the most controls
// per pixel, and its addresses offer different ones, so a name or label lost on one address is
// invisible on the others.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/media-emulation.js";
import {
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountComposerSessionDefault,
} from "./feature-mounts/composer.js";
import { type MountedView } from "./feature-mounts/queries.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "#renderer/styles/tokens.js";

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
