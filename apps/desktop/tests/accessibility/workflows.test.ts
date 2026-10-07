// The accessibility tier over every view the workflows feature registers, each scoped to
// itself so a violation names the view that owns it, in both schemes for `app-frame.test.ts`'s
// reason. `registerWorkflowScreens` claims one rail destination, audited on the Runs tab and on
// one run's page, and `registerWorkflowPanes` the builder pane.
//
// A run's page draws its graph from a lazily loaded chunk, so every row is settled through the
// shared readiness helper before axe runs; the helper tells "no graph here" from "the graph has
// not arrived", so no row needs an exception. A run's page on a form wait carries the step
// panel's form, drawn from the step's fields; it is audited as it opens and again once a person
// has added an entry to its repeated field and pressed Submit with answers the form refuses, the
// state that draws each entry's group and marks every refused control invalid.

import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";

import { emulateSystemScheme } from "../helpers/media-emulation.js";
import { awaitRunGraphSettled, isRunGraphSettled } from "../helpers/run-graph-settled.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPage,
  mountWorkflowRunsTab,
} from "./feature-mounts/workflows.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "#renderer/styles/tokens.js";

/**
 * The views this feature ships, each named as a reader would name it, and words each draws only
 * once its reads have answered, so an audit never covers a loading line in place of the view.
 * One row per registered view: a pane kind with no row here would be reported clean without
 * ever being mounted.
 */
const AUDITED_VIEWS: readonly {
  readonly label: string;
  /** Mounts the view and waits until it draws `drawnWords`. */
  readonly mount: (drawnWords: readonly string[]) => Promise<HTMLElement>;
  readonly drawnWords: readonly string[];
  /** What a person does on the mounted view before it is audited, asserting what it drew. */
  readonly arrange?: (mounted: HTMLElement) => void;
}[] = [
  {
    label: "the Runs tab",
    mount: async (drawnWords) => (await mountWorkflowRunsTab(drawnWords)).element,
    // A runs-table heading and an attention line: each draws only once its own read has answered.
    drawnWords: ["Started by", "waiting on Approve release"],
  },
  {
    label: "a run's page waiting on a form",
    mount: async (drawnWords) =>
      (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.waitingForm, drawnWords)).element,
    drawnWords: ["Submit"],
  },
  {
    label: "a run's page waiting on a form, an entry added and the answers refused",
    mount: async (drawnWords) =>
      (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.waitingForm, drawnWords)).element,
    drawnWords: ["Submit"],
    arrange: addEntryAndSubmitRefused,
  },
  {
    label: "a run's page that failed",
    mount: async (drawnWords) =>
      (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.failed, drawnWords)).element,
    drawnWords: ["Fix it and press Resume, or cancel the run"],
  },
  {
    label: "a run's page waiting for a chat reply",
    mount: async (drawnWords) =>
      (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.waitingReply, drawnWords)).element,
    drawnWords: ["Which label should these issues get?"],
  },
  {
    label: "a chain's first run holding its question",
    mount: async (drawnWords) =>
      (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.chainHeld, drawnWords)).element,
    drawnWords: ["Stop them all"],
  },
  {
    label: "a finished run's page",
    mount: async (drawnWords) =>
      (await mountWorkflowRunPage(WORKFLOW_RUN_IDS.succeeded, drawnWords)).element,
    drawnWords: ["Open in Review"],
  },
  {
    label: "the builder pane on a definition",
    mount: async () => (await mountWorkflowBuilderPane()).element,
    // The pane puts no read in flight, so its summary line stands at mount; it proves the body
    // drew inside the frame.
    drawnWords: ["A definition as a graph"],
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
        const mounted = await view.mount(view.drawnWords);
        for (const words of view.drawnWords) {
          expect(mounted.textContent).toContain(words);
        }
        view.arrange?.(mounted);
        // Settled after the person's steps, since a step that grows the panel resizes the graph
        // beside it, which the graph then places its view for.
        await awaitRunGraphSettled(mounted);
        // The subject, stated before it is read, so the wait above cannot be dropped silently:
        // the fit has not landed at the mount's return whether the lazy chunk is cold or cached.
        // For rows that draw no graph the reading is true by construction.
        expect(isRunGraphSettled(mounted)).toBe(true);

        expect(describeViolations(await runTierAxe(mounted))).toStrictEqual([]);
      });
    }
  }
});

/**
 * Add one entry to the form's repeated field, then press Submit with the required answers empty.
 * Each is asserted as drawn, since an audit of a form with no entry and no refusal covers neither.
 */
function addEntryAndSubmitRefused(mounted: HTMLElement): void {
  const form = within(mounted);
  fireEvent.click(form.getByRole("button", { name: "Add Highlight" }));
  fireEvent.click(form.getByRole("button", { name: "Submit" }));

  const entry = form.getByRole("group", { name: "Highlight 1" });
  const summary = within(entry).getByRole("textbox", { name: /^Summary/u });
  expect(summary.getAttribute("aria-invalid")).toBe("true");
  const version = form.getByRole("textbox", { name: /^Version/u });
  expect(version.getAttribute("aria-invalid")).toBe("true");
}
