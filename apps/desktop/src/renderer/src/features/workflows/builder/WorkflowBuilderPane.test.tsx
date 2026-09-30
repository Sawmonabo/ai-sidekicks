// A builder with no definition states its condition; one with a definition mounts both mount
// points. Assertions target the mounted regions, not the copy, because a pane that dropped its
// mount points would read the same and be useless once a body lands.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { DEFINITION_ID } from "../definitions/detail/hooks/useWorkflowDefinitionAuthoring.test-support.js";
import { PROBE_SESSION_ID } from "../workflows-probe.test-support.js";
import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";

/**
 * Any console entity or none: what the pane's guards accept, not the typed address arm for
 * this kind, which cannot express the misaddressed cases.
 */
type AddressedEntity = EntityRef | undefined;

/**
 * The fields the pane and its chrome read. Cast rather than constructed because a real pane
 * context carries a store that opens a database on construction; the cast also lets a case
 * address the pane at an entity kind its type forbids, as a parsed layout row can.
 */
function paneContext(entity: AddressedEntity): PaneContextOf<"workflow-builder"> {
  return {
    kind: "workflow-builder",
    entity,
    sessionStore: { sessionId: PROBE_SESSION_ID },
    uiStateStore: {},
    draftStore: {},
    // No actor attributes this pane in a suite, which is the chrome's neutral arm.
  } as unknown as PaneContextOf<"workflow-builder">;
}

function renderPane(context: PaneContextOf<"workflow-builder">): HTMLElement {
  const { container } = render(<WorkflowBuilderPane context={context} />);
  // Scoped to the whole pane section, head included.
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

// The kind this pane authors and one it does not; the misaddress has its own cases.
const ADDRESSED = { kind: "workflow-definition", id: DEFINITION_ID } as const;
const MISADDRESSED = { kind: "workflow-run", id: "run-01" } as const;

describe("workflow builder pane — with no definition to open", () => {
  it("states that it was opened with nothing to author, and lists nothing", () => {
    const section = renderPane(paneContext(undefined));

    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(section.textContent ?? "").toContain("opened without a definition to author");
  });
});

describe("workflow builder pane — with a definition to open", () => {
  it("mounts the node-graph and drafts mount points inside the ready strip", () => {
    // The strip renders children on its `ready` arm alone.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__mount-point")).toHaveLength(2);
  });
});

describe("workflow builder pane — with an address it does not author", () => {
  it("refuses the address rather than reading a run id as a definition id", () => {
    // A run id addressed here must not be read as a definition id.
    const section = renderPane(paneContext(MISADDRESSED));
    expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    expect(section.textContent ?? "").toContain("pane-address-invalid");
  });

  it("mounts no body for a subject it will not open", () => {
    // The refusal fills the whole pane: mount points beside the banner would compose the read
    // it says it did not.
    const section = renderPane(paneContext(MISADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__mount-point")).toHaveLength(0);
  });

  it("negative control: the same pane opens on the kind it does author", () => {
    // Guards against a pane that refused every address, which would make the builder unreachable.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(section.querySelectorAll(".meridian-workflow__mount-point")).toHaveLength(2);
  });
});
