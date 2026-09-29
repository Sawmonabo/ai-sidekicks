// The accessibility tier over every surface the workflows family registers.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// EVERY REGISTERED SURFACE, WHICH IS THE WHOLE CLAIM. `registerWorkflowSurfaces`
// claims one rail destination and `registerWorkflowPanes` claims TWO pane kinds, so
// the table below carries a row for each: a family-wide tier that skipped one could not
// fail on a regression unique to it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other.
//
// AND THE RUN'S PHASE GRAPH, WHICH NO SURFACE MOUNTS YET. It is audited as a piece, from
// a hand-built parked run, because its canvas, its focusable nodes and the library's
// attribution link are drawn by nothing a registered surface reaches until the run read
// is built. It is a lazily-loaded chunk, so every row is settled through the shared
// readiness helper before axe runs — every row, not the one known to draw a graph,
// because the helper answers "no graph here" and "the graph has not arrived"
// differently and a per-row exception would be a second rule to keep true.
//
// AND ONE COMPOSITION NO REGISTERED SURFACE CAN REACH. A human phase's form draws a
// repeated control per list entry, and an entry exists only after a person adds one. It
// is audited as a component under one scheme, because it carries no surface of its own.

import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../../test/console/console-harness.js";
import { awaitPhaseGraphSettled, isPhaseGraphSettled } from "../helpers/run-graph-settled.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPane,
  mountWorkflowRunPhaseGraph,
  mountWorkflowsDestination,
} from "../helpers/feature-mounts/workflows.js";
// The seat mount, which resolves BOTH chunks a form needs and returns only once the
// verdict has landed. The kit is not on the initial graph — its two composed surfaces
// and its own sheet arrive together when a form first mounts — so mounting it is also
// what puts that sheet on the page. The family sheet the entry's controls draw against
// is already there: `../surfaces/workflows.js` above imports the family door for its
// registrars.
import {
  isSchemaFormSettled,
  mountSettledSchemaForm,
} from "../helpers/feature-mounts/schema-form.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { CONSOLE_SCHEMES } from "@renderer/styles/tokens.js";

/**
 * The surfaces this family ships, each named as a reader would name it, and the graph.
 *
 * One row per registered surface, and the count is the family's rather than this
 * file's: a pane kind claimed by `registerWorkflowPanes` with no row here is a
 * surface this tier reports clean on without ever having mounted it.
 */
const AUDITED_SURFACES: readonly {
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

describe("accessibility — the workflows surfaces", () => {
  for (const surface of AUDITED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`has no axe violation on ${surface.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();
        await awaitPhaseGraphSettled(mounted);
        // The subject, stated before it is read, so the wait above cannot be dropped
        // in silence: the fit has not landed at the mount's return whether the lazy
        // chunk is cold or already cached. For the rows that draw no graph the reading
        // is true by construction, which is what lets one line cover the table.
        expect(isPhaseGraphSettled(mounted)).toBe(true);

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
            // A constraint on the ENTRY rather than on the collection, so the added
            // entries carry findings of their own: the composition audited here is a
            // repeated control with a name, a verdict, and the relationship between
            // them, and a form with nothing wrong with it would audit none of that.
            items: { type: "string", minLength: 3 },
          },
        },
        required: ["reviewers"],
      },
    });
    // The subject, stated before it is read, on the phase-graph line's reasoning above:
    // a form still waiting for its compiler draws no finding at all, so an audit taken
    // there covers a repeated control without the verdict this case is about.
    expect(isSchemaFormSettled(container)).toBe(true);
    const addEntry = screen.getByRole("button", { name: "Add an entry to Reviewers" });
    fireEvent.click(addEntry);
    fireEvent.click(addEntry);
    // Stated before it is measured: an audit of a list with no entries audits none of
    // the repeated control this case is about.
    expect(container.querySelectorAll(".meridian-schema-list__item")).toHaveLength(2);

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("has no axe violation on the raw editor while the schema refuses the document", async () => {
    // THE OTHER ARM, AND THE ONE WHERE EVERYTHING IS IN ONE CONTROL. A schema outside the
    // drawn set is answered as JSON, so the verdict on the whole answer has a single
    // textarea to attach to — and until this landed it attached to nothing, leaving a
    // reader who never moves focus out of the editor with no indication of the invalid
    // state and no route to the sentences. The mount is a component's for the reason the
    // list-entry case above is: no registered surface opens this arm.
    const container = await mountSettledSchemaForm({
      prompt: "Describe the rows this phase should publish.",
      inputSchema: {
        type: "object",
        // An array of objects is outside the drawn render set, so the mapper answers
        // with the editor — and the schema still compiles, so there is a verdict.
        properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
        required: ["rows"],
      },
    });
    // The subject, stated before it is read: the invalid state below is the schema's
    // verdict on the empty document, and a form still compiling carries neither.
    expect(isSchemaFormSettled(container)).toBe(true);
    const editor = container.querySelector(".meridian-schema-raw__editor");

    // Stated before it is measured: an audit of a valid document is an audit of a surface
    // carrying neither the invalid state nor the findings this case exists for.
    expect(editor?.getAttribute("aria-invalid")).toBe("true");

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("finds a planted violation, so a clean result means something", async () => {
    // Negative control for this file's own runs: every case above expects an empty
    // list, and a misconfigured run returns exactly the same empty list.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
