// What a person sees once a definition has been read, and what each of the two acts
// answers.
//
// THE ACTS ARE ASSERTED ON THEIR ANSWERS AND NOT ON THEIR CONTROLS. Whether a caller
// may write at a scope is the daemon's adjudication, so every control is pressable and
// what a case checks is what came back: the export's bytes, the create's request, the
// parse's reason.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { PROBE_SESSION_ID, settle } from "../../workflows-probe.test-support.js";
import { DefinitionDetail } from "./DefinitionDetail.js";
import {
  DEFINITION_ID,
  RELEASE_CHECKS_BODY,
  RELEASE_CHECKS_DEFINITION,
  answeringCreate,
  authoringBridge,
} from "./hooks/useWorkflowDefinitionAuthoring.test-support.js";
import { useWorkflowDefinitionAuthoring } from "./hooks/useWorkflowDefinitionAuthoring.js";
import type { WorkflowDefinitionCreateCall } from "./definition-authoring-runtime.js";
import type { WorkflowDefinitionDetailState } from "./hooks/useWorkflowDefinitionDetail.js";

afterEach(cleanup);

/** A definition whose three reads all answered. */
const SERVED: Extract<WorkflowDefinitionDetailState, { status: "served" }> = {
  status: "served",
  detail: {
    definition: RELEASE_CHECKS_DEFINITION,
    version: RELEASE_CHECKS_BODY,
    chain: {
      status: "served",
      versions: [
        {
          workflowVersionId: RELEASE_CHECKS_BODY.workflowVersionId,
          versionNumber: RELEASE_CHECKS_BODY.versionNumber,
        },
      ],
    },
  },
};

/** The detail wired to the real authoring hook, the way a container hands it its props. */
function DetailWithActs(props: {
  readonly detail: WorkflowDefinitionDetailState;
  readonly bridge: ConsoleBridge;
  readonly createDefinition: WorkflowDefinitionCreateCall;
}): React.JSX.Element {
  const authoring = useWorkflowDefinitionAuthoring(
    props.bridge,
    props.createDefinition,
    DEFINITION_ID,
    PROBE_SESSION_ID,
    RELEASE_CHECKS_BODY,
  );
  return <DefinitionDetail detail={props.detail} authoring={authoring} />;
}

/** The detail mounted on one read state, with a create call the import can reach. */
function renderDetail(
  detail: WorkflowDefinitionDetailState = SERVED,
  createDefinition: WorkflowDefinitionCreateCall = answeringCreate,
): HTMLElement {
  const { container } = render(
    <DetailWithActs
      detail={detail}
      bridge={authoringBridge()}
      createDefinition={createDefinition}
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

describe("the definition detail — a read definition drawn", () => {
  it("draws the version body's hash, marker and named phases", () => {
    const container = renderDetail();
    const text = container.textContent ?? "";

    expect(text).toContain("b3:");
    expect(container.querySelector(".meridian-definition-detail__version")).not.toBeNull();
    // The phase NAME, which is the fact no run read carries at all.
    expect(container.querySelectorAll(".meridian-definition-detail__phase").length).toBeGreaterThan(
      0,
    );
    expect(text).toContain("Draft the release note");
  });

  it("draws the version chain where the definition read named one", () => {
    const container = renderDetail();

    expect(container.querySelector(".meridian-definition-detail__chain-list")).not.toBeNull();
  });

  it("keeps the identity and body when the chain could not be asked for", () => {
    // The partial reading, rendered: the definition read carried no version id, so no chain
    // is drawn while the definition and its body still stand.
    const container = renderDetail({
      status: "served",
      detail: { ...SERVED.detail, chain: { status: "unaddressable" } },
    });

    expect(container.querySelector(".meridian-definition-detail__version")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing")).toBeNull();
    expect(container.querySelector(".meridian-definition-detail__chain")).toBeNull();
  });
});

describe("the definition detail — the two acts and what each answers", () => {
  it("exports the version body into the file form, and leaves the bytes on screen", async () => {
    const container = renderDetail();

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

  it("refuses an unreadable import in the file reader's own words", async () => {
    const container = renderDetail();

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

  it("puts a WELL-FORMED import to the create call, which is where it settles", async () => {
    // The negative control for the case above: without it, the parse refusal would hold
    // over an import that refused every input, and no file would ever reach the create.
    const createDefinition = vi.fn(answeringCreate);
    const container = renderDetail(SERVED, createDefinition);

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
    expect(outcomes?.textContent ?? "").toContain("Release checks was created in this session");
    expect(createDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: PROBE_SESSION_ID, name: "Release checks" }),
    );
  });

  it("says nothing about an act nobody pressed", () => {
    // Rule 8's kinds of nothing are about reads a person is waiting on, not controls
    // they have not touched — so an untouched act renders no row at all, and this is
    // the control that keeps the outcome list from narrating the console's inactivity.
    const container = renderDetail();

    expect(container.querySelectorAll(".meridian-definition-detail__outcome")).toHaveLength(0);
  });
});
