// The accessibility tier over every view the workflows feature registers, each scoped to
// itself so a violation names the view that owns it, in both schemes for `app-frame.test.tsx`'s
// reason. `registerWorkflowScreens` claims one rail destination and `registerWorkflowPanes`
// two pane kinds, so the table below has a row for each.
//
// The run's phase graph is audited as a piece from a hand-built parked run. It is a
// lazily-loaded chunk, so every row is settled through the shared readiness helper before axe
// runs; the helper tells "no graph here" from "the graph has not arrived", so no row needs an
// exception.
//
// A human phase's form draws a repeated control per list entry, which exists only after a
// person adds one, so it is audited as a component under one scheme.

import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { awaitRunGraphSettled, isRunGraphSettled } from "../helpers/run-graph-settled.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPane,
  mountWorkflowRunPhaseGraph,
  mountWorkflowsDestination,
} from "../helpers/feature-mounts/workflows.js";
// The schema form mount resolves both chunks a form needs and returns once the verdict has
// landed. The form kit's sheet arrives with its chunk, so mounting it also puts that sheet on
// the page.
import {
  isSchemaFormSettled,
  mountSettledSchemaForm,
} from "../helpers/feature-mounts/schema-form.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/**
 * The views this feature ships, each named as a reader would name it, and the graph. One row
 * per registered view: a pane kind with no row here would be reported clean without ever
 * being mounted.
 */
const AUDITED_VIEWS: readonly {
  readonly label: string;
  readonly mount: () => Promise<HTMLElement>;
}[] = [
  {
    label: "the workflows destination",
    mount: async () => (await mountWorkflowsDestination()).element,
  },
  { label: "the run pane on a run", mount: async () => (await mountWorkflowRunPane()).element },
  {
    label: "the builder pane on a definition",
    mount: async () => (await mountWorkflowBuilderPane()).element,
  },
  { label: "a parked run's phase graph", mount: mountWorkflowRunPhaseGraph },
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

        expect(describeViolations(await runTierAxe(mounted))).toStrictEqual([]);
      });
    }
  }

  it("has no axe violation on a human phase's form once list entries are added", async () => {
    const container = await mountSettledSchemaForm({
      prompt: "Who signs this release off?",
      inputSchema: {
        type: "object",
        properties: {
          reviewers: {
            type: "array",
            title: "Reviewers",
            // A constraint on the entry rather than the collection, so added entries carry
            // findings of their own: the audited composition is a repeated control with a name,
            // a verdict and the relationship between them.
            items: { type: "string", minLength: 3 },
          },
        },
        required: ["reviewers"],
      },
    });
    // Stated before it is read: a form still waiting for its compiler draws no finding, so an
    // audit taken there would cover a repeated control without the verdict this case is about.
    expect(isSchemaFormSettled(container)).toBe(true);
    const addEntry = screen.getByRole("button", { name: "Add an entry to Reviewers" });
    fireEvent.click(addEntry);
    fireEvent.click(addEntry);
    // An audit of a list with no entries audits none of the repeated control.
    expect(container.querySelectorAll(".meridian-schema-list__item")).toHaveLength(2);

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("has no axe violation on the raw editor while the schema refuses the document", async () => {
    // The other arm, where everything is in one control: a schema outside the drawn set is
    // answered as JSON, so the verdict on the whole answer has a single textarea to attach to,
    // and a reader who never leaves the editor must still get the invalid state and a route to
    // the sentences. It is mounted as a component, like the list-entry case, because no
    // registered view opens this arm.
    const container = await mountSettledSchemaForm({
      prompt: "Describe the rows this phase should publish.",
      inputSchema: {
        type: "object",
        // An array of objects is outside the drawn render set, so the mapper answers with the
        // editor, and the schema still compiles, so there is a verdict.
        properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
        required: ["rows"],
      },
    });
    // Stated before it is read: the invalid state below is the schema's verdict on the empty
    // document, and a form still compiling carries neither.
    expect(isSchemaFormSettled(container)).toBe(true);
    const editor = container.querySelector(".meridian-schema-raw__editor");

    // An audit of a valid document carries neither the invalid state nor the findings.
    expect(editor?.getAttribute("aria-invalid")).toBe("true");

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });
});
