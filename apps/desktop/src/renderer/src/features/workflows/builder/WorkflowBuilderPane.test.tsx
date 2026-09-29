// A builder with no definition states its condition; a builder with one mounts both
// reserved bodies and says plainly that it cannot save.
//
// The addressed arm is asserted on the REGIONS it mounts rather than on its copy, which
// is this family's to reword. Two of them are the reason the arm exists: an addressed
// pane that dropped its slots would look identical to one that had them and be useless
// the day a body lands.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PaneContextOf } from "@renderer/console/seats/index.js";
import type { ConsoleEntityRef } from "@renderer/console/store/entities/entities.js";
import { DEFINITION_ID } from "../definitions/detail/hooks/useWorkflowDefinitionAuthoring.test-support.js";
import { PROBE_SESSION_ID } from "../workflows-probe.test-support.js";
import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";

/**
 * What a cast pane context may be addressed at.
 *
 * Any console entity or none — the set the pane's own two guards project, rather than
 * `ConsolePaneAddress`'s own arm for this kind, because the cases below drive exactly
 * the addresses the arm makes unconstructible and the guards still refuse.
 */
type AddressedEntity = ConsoleEntityRef | undefined;

/**
 * The fields the pane and its chrome read, and nothing else.
 *
 * Cast rather than constructed, the idiom `RunPage.test-support.tsx`
 * established: a real pane context carries three stores, one of which opens a database
 * on construction. The two stores travel as markers because this pane only hands them
 * on — the slots' own tests are where what a body receives is checked.
 *
 * THE CAST IS ALSO WHAT LETS THE MISADDRESSED CASES EXIST. `PaneContextOf` declares
 * this arm's entity as a definition reference, and the addresses below are exactly the
 * ones that arm makes unconstructible and the pane's guards still refuse — which is
 * the situation a parsed layout row actually produces.
 */
function paneContext(entity: AddressedEntity): PaneContextOf<"workflow-builder"> {
  return {
    kind: "workflow-builder",
    entity,
    sessionStore: { sessionId: PROBE_SESSION_ID },
    uiStateStore: {},
    draftStore: {},
    // No actor attributes this pane in a suite, which is the chrome's neutral arm.
    focusHue: undefined,
  } as unknown as PaneContextOf<"workflow-builder">;
}

function renderPane(context: PaneContextOf<"workflow-builder">): HTMLElement {
  const { container } = render(<WorkflowBuilderPane context={context} />);
  // The pane chrome's own `<section>` — every assertion below is scoped to the whole
  // pane, head included, because the head is where the save act and the address trail
  // now stand.
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

// The kind this pane authors, and the kind it does not: `CONSOLE_ENTITY_KINDS` registers
// both `workflow-definition` and `workflow-run`, and the misaddress is the subject of its
// own cases.
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
  it("mounts the node-graph and drafts slots inside the ready strip", () => {
    // The strip renders children on its `ready` arm alone, so a pane that handed it
    // another state would drop these two silently.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
  });
});

describe("workflow builder pane — with an address it does not author", () => {
  it("refuses the address rather than reading a run id as a definition id", () => {
    // The defect: the pane took `entity.id` off any kind at all, so a run id
    // addressed here was carried into the definition read and whatever came back
    // would have been presented as the definition a person asked to edit.
    const section = renderPane(paneContext(MISADDRESSED));
    expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    expect(section.textContent ?? "").toContain("pane-address-invalid");
  });

  it("mounts no body for a subject it will not open", () => {
    // The refusal has to be the whole surface: a pane that refused in a banner and still
    // mounted its two slots would have composed the read the banner says it did not.
    const section = renderPane(paneContext(MISADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(0);
  });

  it("negative control: the same pane opens on the kind it does author", () => {
    // Without this, both cases above pass over a pane that refused every address,
    // which would make the builder unreachable rather than fail-closed.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
  });
});
