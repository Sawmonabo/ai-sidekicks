// The accessibility tier over every view the workflows feature registers, each scoped to
// itself so a violation names the view that owns it, in both schemes for `app-frame.test.ts`'s
// reason. `registerWorkflowScreens` claims one rail destination, audited on the Runs tab and on
// one run's page, and `registerWorkflowPanes` the builder pane.
//
// A run's page draws its graph from a lazily loaded chunk, so every row is settled through the
// shared readiness helper before axe runs; the helper tells "no graph here" from "the graph has
// not arrived", so no row needs an exception. A run's page on a form wait carries the step
// panel's form, drawn from the step's fields.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_RUN_IDS } from "@fixtures/data/workflow/runs.js";

import { emulateSystemScheme } from "../helpers/app/harness.js";
import { awaitRunGraphSettled, isRunGraphSettled } from "../helpers/run-graph-settled.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPage,
  mountWorkflowRunsTab,
} from "./feature-mounts/workflows.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/**
 * The views this feature ships, each named as a reader would name it, and words each draws only
 * once its reads have answered, so an audit never covers a loading line in place of the view.
 * One row per registered view: a pane kind with no row here would be reported clean without
 * ever being mounted.
 */
const AUDITED_VIEWS: readonly {
  readonly label: string;
  readonly mount: () => Promise<HTMLElement>;
  readonly drawnWords: readonly string[];
}[] = [
  {
    label: "the Runs tab",
    mount: async () => (await mountWorkflowRunsTab()).element,
    // A runs-table heading and an attention line: each draws only once its own read has answered.
    drawnWords: ["Started by", "waiting on your approval"],
  },
  {
    label: "a run's page waiting on a form",
    mount: async () => (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.waitingForm)).element,
    drawnWords: ["Submit"],
  },
  {
    label: "a run's page that failed",
    mount: async () => (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.failed)).element,
    drawnWords: ["Fix it and press Resume, or cancel the run"],
  },
  {
    label: "a run's page waiting for a chat reply",
    mount: async () => (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.waitingReply)).element,
    drawnWords: ["Which label should these issues get?"],
  },
  {
    label: "a chain's first run holding its question",
    mount: async () => (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.chainHeld)).element,
    drawnWords: ["Stop them all"],
  },
  {
    label: "a finished run's page",
    mount: async () => (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.succeeded)).element,
    drawnWords: ["Open in Review"],
  },
  {
    label: "the builder pane on a definition",
    mount: async () => (await mountWorkflowBuilderPane()).element,
    drawnWords: [],
  },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the workflows views", () => {
  for (const view of AUDITED_VIEWS) {
    for (const scheme of COLOR_SCHEMES) {
      it(`has no axe violation on ${view.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        const mounted = await view.mount();
        await awaitRunGraphSettled(mounted);
        // The subject, stated before it is read, so the wait above cannot be dropped silently:
        // the fit has not landed at the mount's return whether the lazy chunk is cold or cached.
        // For rows that draw no graph the reading is true by construction.
        expect(isRunGraphSettled(mounted)).toBe(true);
        for (const words of view.drawnWords) {
          expect(mounted.textContent).toContain(words);
        }

        expect(describeViolations(await runTierAxe(mounted))).toStrictEqual([]);
      });
    }
  }
});
