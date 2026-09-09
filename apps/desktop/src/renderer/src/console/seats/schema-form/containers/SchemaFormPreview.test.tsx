// The inspector's reading of a human phase's form: drawn where there is one, absent
// everywhere else, and never offering to send an answer.
//
// The absent cases are the ones that keep a definition row a row. Four of the five phase
// types ask nothing, and a human phase whose definition carried no schema is not a phase
// with an empty form — it is a phase this pane has nothing to draw for.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SchemaFormPreview } from "./SchemaFormPreview.js";
import type { WorkflowPhaseDefinition } from "../../../bridge/index.js";

afterEach(cleanup);

/** One phase of the given type, carrying the given config and nothing else of interest. */
function phase(
  type: WorkflowPhaseDefinition["type"],
  config?: Readonly<Record<string, unknown>>,
): WorkflowPhaseDefinition {
  return {
    phaseId: "019b7a10-0280-7d22-8100-be5100150301",
    name: "Sign off the release",
    type,
    gateType: "human-approval",
    failureBehavior: "stop",
    ...(config === undefined ? {} : { config }),
  };
}

/** The config a human phase carries when it asks one question. */
const ONE_QUESTION = {
  prompt: "Does this release look right to you?",
  inputSchema: { type: "object", properties: { verdict: { type: "string", title: "Verdict" } } },
} as const;

describe("the human phase form preview", () => {
  it("draws the phase's prompt and the controls its schema declares", () => {
    render(<SchemaFormPreview phase={phase("human", ONE_QUESTION)} />);

    expect(screen.getByText(ONE_QUESTION.prompt)).toBeDefined();
    expect(screen.getByLabelText("Verdict")).toBeDefined();
  });

  it("offers no control that would send an answer, because nothing here can send one", () => {
    render(<SchemaFormPreview phase={phase("human", ONE_QUESTION)} />);

    const buttonNames = screen.queryAllByRole("button").map((button) => button.textContent ?? "");

    expect(buttonNames.some((name) => /submit|send|answer/i.test(name))).toBe(false);
  });

  it("says plainly that answering here changes nothing", () => {
    const { container } = render(<SchemaFormPreview phase={phase("human", ONE_QUESTION)} />);

    expect(container.querySelector(".meridian-schema-preview__caption")?.textContent).toContain(
      "answered from its run",
    );
  });

  it("draws nothing at all for a phase type that asks no question", () => {
    for (const type of ["single-agent", "multi-agent", "automated"] as const) {
      const { container } = render(<SchemaFormPreview phase={phase(type, ONE_QUESTION)} />);

      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("draws nothing for a human phase whose definition declared no schema", () => {
    const { container } = render(
      <SchemaFormPreview phase={phase("human", { prompt: "Anything?" })} />,
    );

    expect(container.textContent).toBe("");
  });

  it("opens the raw editor rather than refusing when the schema is outside the drawn set", () => {
    const { container } = render(
      <SchemaFormPreview
        phase={phase("human", {
          prompt: "Anything?",
          // Object-rooted with one member the mapper cannot draw: the raw arm an author
          // is previewing is the one a participant can actually answer from.
          inputSchema: { type: "object", properties: { when: { type: ["string", "null"] } } },
        })}
      />,
    );

    expect(container.querySelector(".meridian-schema-raw__editor")).not.toBeNull();
  });

  it("refuses a root asking for a single value, which no participant could answer", () => {
    // The author is the one person who can repair it, so the preview says what the run's
    // form will say rather than drawing an editor the participant is never offered.
    const { container } = render(
      <SchemaFormPreview
        phase={phase("human", { prompt: "Anything?", inputSchema: { type: "string" } })}
      />,
    );

    expect(container.querySelector(".meridian-schema-raw__editor")).toBeNull();
    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "schema-root-not-named-values",
    );
  });
});
