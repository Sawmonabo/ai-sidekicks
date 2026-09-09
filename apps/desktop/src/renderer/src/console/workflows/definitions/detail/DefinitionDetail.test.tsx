// What a person sees once a browser row opens, and what each of the three acts answers.
//
// EVERY CASE DRIVES THE REAL FIXTURE BRIDGE over the workflows scenario, so what is
// rendered is what that scenario's own tables state. A hand-built port would let this
// suite agree with whatever the component did with it, and the whole subject here is
// that the pane now shows a definition the fixture already described.
//
// THE ACTS ARE ASSERTED ON THEIR ANSWERS AND NOT ON THEIR CONTROLS. Whether a caller
// may write at a scope is the daemon's adjudication and arrives as a typed refusal on
// the press, so every control is pressable and what a case checks is what came back:
// the export's bytes, the create's refusal, the parse's reason.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import {
  DEFINITION_RELEASE_CHECKS_PROJECT,
  DEFINITION_RELEASE_CHECKS_SESSION,
  WORKFLOWS_SESSION_ID,
} from "../../../bridge/scenario/workflows/ids.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenario/workflows/workflows.js";
import { settle } from "../../workflows-probe.test-support.js";
import { DefinitionDetail } from "./DefinitionDetail.js";

afterEach(cleanup);

function scriptedBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
}

/** The detail mounted at one definition, with its own bridge. */
function renderDetail(
  workflowDefinitionId: string,
  bridge: ConsoleBridge = scriptedBridge(),
): HTMLElement {
  const { container } = render(
    <DefinitionDetail
      bridge={bridge}
      workflowDefinitionId={workflowDefinitionId}
      sessionId={WORKFLOWS_SESSION_ID}
    />,
  );
  return container;
}

/** One control, found by the words on it. */
function control(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => (candidate.textContent ?? "").trim() === label,
  );
  if (found === undefined) {
    throw new Error(`no control reads ${label}`);
  }
  return found;
}

describe("the definition detail — what a browser row now opens on", () => {
  it("reads rather than reporting the definition as unread", async () => {
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();

    await settle();
    expect(container.querySelector(".meridian-definition-detail")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("draws the version body's hash, marker and named phases", async () => {
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();
    const text = container.textContent ?? "";

    expect(text).toContain("b3:");
    expect(container.querySelector(".meridian-definition-detail__version")).not.toBeNull();
    // The phase NAME, which is the fact no run read carries at all.
    expect(container.querySelectorAll(".meridian-definition-detail__phase").length).toBeGreaterThan(
      0,
    );
    expect(text).toContain("Draft the release note");
  });

  it("draws the version chain where the fixture states one", async () => {
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    expect(container.querySelector(".meridian-definition-detail__chain-list")).not.toBeNull();
  });

  it("keeps the identity when a qualifying read refuses, and says so beside it", async () => {
    // The partial reading, rendered: the project-scoped copy is pinned to by no run, so
    // the scenario states no chain for it — the definition and its body still stand.
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_PROJECT);
    await settle();

    expect(container.querySelector(".meridian-definition-detail__version")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal--banner")).not.toBeNull();
  });
});

describe("the definition detail — the three acts and what each answers", () => {
  it("exports the version body into the file form, and leaves the bytes on screen", async () => {
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    fireEvent.click(control(container, "Export"));
    // WAITED FOR RATHER THAN SLEPT ON. The file form's writer arrives in its own chunk
    // — the parser is charged to the launches that use it and to no others — so the
    // bytes land when the fetch settles and not a fixed number of turns after a press.
    const file = await waitFor(() => {
      const written = container.querySelector(".meridian-definition-detail__file");
      expect(written).not.toBeNull();
      return written;
    });

    // The bytes are a definition file rather than a rendering of one: the marker the
    // body carries is in them, and so is a phase the definition sequences.
    expect(file?.textContent ?? "").toContain("ai-sidekicks-schema");
    expect(file?.textContent ?? "").toContain("Draft the release note");
  });

  it("refuses a promote through the port rather than composing its own sentence", async () => {
    // The create is on the growth port and no fixture serves it, so the answer a person
    // reads is the PORT's — naming the wire and who owes it. A surface that composed its
    // own refusal here would be asserting a wire fact nobody asked about.
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    fireEvent.click(control(container, "Promote to shared"));
    await settle();

    const outcomes = container.querySelector(".meridian-definition-detail__outcomes");
    expect(outcomes?.textContent ?? "").toContain("wire-unregistered");
  });

  it("refuses an unreadable import in the file reader's own words", async () => {
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    fireEvent.click(control(container, "Import"));
    const box = container.querySelector("textarea");
    expect(box).not.toBeNull();
    if (box === null) {
      return;
    }
    fireEvent.change(box, { target: { value: "not a definition file" } });
    fireEvent.click(control(container, "Submit"));
    await settle();

    const outcomes = container.querySelector(".meridian-definition-detail__outcomes");
    expect(outcomes?.textContent ?? "").toContain("file-unreadable");
  });

  it("sends a WELL-FORMED import to the port, which is where it is refused", async () => {
    // The negative control for the case above: without it, the parse refusal would hold
    // over an import that refused every input, and no file would ever reach the wire.
    // This one reaches it, and the refusal that comes back is the port's rather than the
    // reader's.
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    fireEvent.click(control(container, "Export"));
    const exported = await waitFor(() => {
      const written = container.querySelector(".meridian-definition-detail__file");
      expect(written).not.toBeNull();
      return written;
    });

    fireEvent.click(control(container, "Import"));
    const box = container.querySelector(".meridian-definition-detail__import-box");
    expect(box).not.toBeNull();
    if (box === null) {
      return;
    }
    fireEvent.change(box, { target: { value: exported?.textContent ?? "" } });
    fireEvent.click(control(container, "Submit"));
    await settle();

    const outcomes = container.querySelector(".meridian-definition-detail__outcomes");
    expect(outcomes?.textContent ?? "").not.toContain("file-unreadable");
    expect(outcomes?.textContent ?? "").toContain("wire-unregistered");
  });

  it("says nothing about an act nobody pressed", async () => {
    // Rule 8's kinds of nothing are about reads a person is waiting on, not controls
    // they have not touched — so an untouched act renders no row at all, and this is
    // the control that keeps the outcome list from narrating the console's inactivity.
    const container = renderDetail(DEFINITION_RELEASE_CHECKS_SESSION);
    await settle();

    expect(container.querySelectorAll(".meridian-definition-detail__outcome")).toHaveLength(0);
  });
});
