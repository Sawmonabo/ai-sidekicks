// The seat's two arms, and the one thing its contract may never do.
//
// Both arms are driven here rather than only the empty one, which is why the mount
// takes its seat as a prop: the filled arm is the arm that matters on the day the
// owning plan's body lands, and an arm that has never run is an arm nobody has
// checked. The seats constructed below are real `OwnerSlotProps` values, not a
// stand-in for the module under test — the component, the contract, and the subject
// union all come from the module itself.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OwnerSlotProps } from "../workspace/index.js";
import {
  SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT,
  SidekickDefinitionRecordEditorMount,
  type SidekickDefinitionRecordEditorBody,
} from "./DefinitionEditorSlot.js";

/** A seat whose body has arrived. Renders what it was handed, and nothing else. */
const FILLED_SLOT: OwnerSlotProps<SidekickDefinitionRecordEditorBody> = {
  contract: SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT.contract,
  body: (props) =>
    props.subject.kind === "stored" ? (
      <p>editing {props.subject.definitionId}</p>
    ) : (
      <p>composing a new one</p>
    ),
};

describe("the sidekick editor's seat — while no body has arrived", () => {
  it("states the absence rather than drawing a disabled form", () => {
    const { container } = render(
      <SidekickDefinitionRecordEditorMount
        slot={SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT}
        subject={{ kind: "stored", definitionId: "definition-7" }}
      />,
    );
    expect(container.textContent ?? "").toContain("sidekick editor has not been built here yet");
    // A form would be the failure the reserved treatment exists to avoid: a person
    // cannot tell a feature that is reserved from one that is broken.
    expect(container.querySelector("input, select, textarea, button")).toBeNull();
  });

  it("says the same thing when nothing is selected at all", () => {
    const { container } = render(
      <SidekickDefinitionRecordEditorMount
        slot={SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT}
        subject={undefined}
      />,
    );
    expect(container.textContent ?? "").toContain("sidekick editor has not been built here yet");
  });

  it("negative control: a filled seat renders its body instead", () => {
    // Without this, both cases above would pass over a mount that ignored its seat
    // and rendered the reservation unconditionally — which is exactly the mount
    // that will silently swallow the body on the day it lands.
    const { container } = render(
      <SidekickDefinitionRecordEditorMount
        slot={FILLED_SLOT}
        subject={{ kind: "stored", definitionId: "definition-7" }}
      />,
    );
    expect(container.textContent ?? "").toBe("editing definition-7");
  });
});

describe("the sidekick editor's seat — once a body has arrived", () => {
  it("hands the stored subject through untouched", () => {
    const { container } = render(
      <SidekickDefinitionRecordEditorMount
        slot={FILLED_SLOT}
        subject={{ kind: "stored", definitionId: "definition-42" }}
      />,
    );
    expect(container.textContent ?? "").toBe("editing definition-42");
  });

  it("hands the new-record subject through as its own arm", () => {
    // The two arms are different acts behind different verbs; a mount that
    // collapsed them would hand the body an absence to infer from.
    const { container } = render(
      <SidekickDefinitionRecordEditorMount slot={FILLED_SLOT} subject={{ kind: "new" }} />,
    );
    expect(container.textContent ?? "").toBe("composing a new one");
  });

  it("negative control: a filled seat with no subject still reserves", () => {
    // Without this, the two cases above would pass over a mount that rendered the
    // body regardless — which would call it with a subject it does not have.
    const { container } = render(
      <SidekickDefinitionRecordEditorMount slot={FILLED_SLOT} subject={undefined} />,
    );
    expect(container.textContent ?? "").toContain("has not been built here yet");
  });
});

describe("the sidekick editor's seat — what its contract may not do", () => {
  it("reaches no screen", () => {
    // The contract is developer-facing in terms (`workspace/seats/owner-slot.ts`),
    // and every member of it names governance work, which a participant never reads.
    const { contract } = SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT;
    const { container } = render(
      <SidekickDefinitionRecordEditorMount
        slot={SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT}
        subject={undefined}
      />,
    );
    const rendered = container.textContent ?? "";
    expect(rendered).not.toContain(contract.owningTask);
    expect(rendered).not.toContain(contract.mountObligation);
    expect(rendered).not.toContain(contract.deleteShellIn);
    expect(rendered).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
  });

  it("negative control: the mount does render text that could have carried it", () => {
    // Without this, the case above would pass over a mount that rendered nothing at
    // all — which is the failure it is meant to exclude, since an empty region and
    // a region that names no governance work are indistinguishable to `toContain`.
    const { container } = render(
      <SidekickDefinitionRecordEditorMount
        slot={SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT}
        subject={undefined}
      />,
    );
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });

  it("answers all three of the questions a seat exists to answer", () => {
    // A seat that cannot say who owns the body, what the mount owes it, and where
    // the shell dies has not decided what it is (`workspace/seats/owner-slot.ts`).
    const { contract } = SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT;
    expect(contract.owningTask.length).toBeGreaterThan(0);
    expect(contract.mountObligation.length).toBeGreaterThan(0);
    expect(contract.deleteShellIn.length).toBeGreaterThan(0);
  });
});
