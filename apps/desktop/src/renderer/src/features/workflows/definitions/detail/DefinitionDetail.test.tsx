// The definition detail's two acts, end to end: export writes the file, and importing that file
// puts a create. Acts are asserted on their answers, not their controls: whether a caller may
// write at a scope is the daemon's adjudication, so every control is pressable.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { PROBE_SESSION_ID, settle, versionChainEntry } from "../../workflows-probe.test-support.js";
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
        versionChainEntry(RELEASE_CHECKS_BODY.workflowVersionId, RELEASE_CHECKS_BODY.versionNumber),
      ],
    },
  },
};

/** The detail wired to the real authoring hook, the way a container hands it its props. */
function DetailWithActs(props: {
  readonly detail: WorkflowDefinitionDetailState;
  readonly bridge: PlatformBridge;
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

describe("the definition detail — the two acts and what each answers", () => {
  it("exports the version body into the file form, and leaves the bytes on screen", async () => {
    const container = renderDetail();

    fireEvent.click(control(container, "Export"));
    // Waited for, not slept on: the writer arrives in its own chunk, so the bytes land when the
    // fetch settles.
    const file = await waitFor(() => {
      const written = container.querySelector(".meridian-definition-detail__file");
      expect(written).not.toBeNull();
      return written;
    });

    // The bytes are a definition file: the body's marker and a sequenced phase are in them.
    expect(file?.textContent ?? "").toContain("ai-sidekicks-schema");
    expect(file?.textContent ?? "").toContain("Draft the release note");
  });

  it("creates a definition from an exported file pasted into the import", async () => {
    // Guards against an import that refused every input, so no file ever reached the create.
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
});
