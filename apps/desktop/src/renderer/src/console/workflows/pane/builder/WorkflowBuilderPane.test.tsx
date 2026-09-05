// A builder with no definition states its condition; a builder with one mounts both
// reserved bodies and says plainly that it cannot save.
//
// The unaddressed arm used to render the definitions browser, and the case for that
// was "pick one, or start one" — but the browser was mounted with no navigation
// callback and nothing in this build authors a definition, so neither move was
// available and the arm was a read-only copy of the list a person had just left. The
// cases below pin the replacement by what it does NOT mount as much as by what it
// does.
//
// The addressed arm is asserted on the REGIONS it mounts rather than on its copy,
// which is this family's to reword. Two of them are the reason the arm exists: an
// addressed pane that dropped its slots would look identical to one that had them
// and be useless the day a body lands.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../../../bridge/scenarios/workflow-fixture-ids.js";
import type { PaneContextOf } from "../../../seats/index.js";
import type { ConsoleEntityRef } from "../../../store/index.js";
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
 * Cast rather than constructed, the idiom `WorkflowRunPane.test-support.tsx`
 * established: a real pane context carries three stores, one of which opens a database
 * on construction. The two stores travel as markers because this pane only hands them
 * on — the slots' own tests are where what a body receives is checked. The bridge is
 * real so that a read composed by mistake would reach a port that answers, rather
 * than passing because nothing was there to ask.
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
    bridge: createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }),
    sessionStore: { sessionId: WORKFLOWS_SESSION_ID },
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

// The kind this pane authors, and the kind it does not.
//
// `CONSOLE_ENTITY_KINDS` registers BOTH `workflow-definition` and `workflow-run`,
// and has since the set was written — this file used to address a definition under
// `workflow-run` on the stated grounds that no definition kind existed, which was
// simply false and had the suite asserting the pane's behaviour on the one address
// it must now refuse. The misaddress is kept, as the subject of its own cases.
const ADDRESSED = { kind: "workflow-definition", id: "definition-01" } as const;
const MISADDRESSED = { kind: "workflow-run", id: "run-01" } as const;

describe("workflow builder pane — with no definition to open", () => {
  it("states that it was opened with nothing to author, and lists nothing", () => {
    // The finding: this arm rendered a definitions browser with neither navigation
    // callback, so every name in it was a plain span and the press that opened the
    // pane landed on a list from which nothing could advance.
    const section = renderPane(paneContext(undefined));

    expect(section.querySelectorAll(".meridian-workflow__scope-heading")).toHaveLength(0);
    expect(section.querySelector(".meridian-workflow__scopes")).toBeNull();
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(section.textContent ?? "").toContain("opened without a definition to author");
  });

  it("offers no save affordance where there is nothing to save", () => {
    // Negative control for the refusal case below: it would pass over a pane that
    // rendered the same header on every arm, which would offer to save a definition
    // the person has not chosen yet.
    const section = renderPane(paneContext(undefined));
    expect(section.querySelector(".meridian-workflow__authoring")).toBeNull();
  });
});

/**
 * Element names a `<span>` may not contain, as the case below reads the rule.
 *
 * The forbidden set rather than the permitted one: the strip legitimately holds spans,
 * buttons and an `<svg>` glyph with whatever that element carries inside it, and an
 * allow-list would have to enumerate SVG's own vocabulary to say so.
 */
const FLOW_ONLY_ELEMENTS: readonly string[] = [
  "div",
  "p",
  "section",
  "article",
  "ol",
  "ul",
  "li",
  "table",
];

describe("workflow builder pane — with a definition to open", () => {
  it("reports the definition as unread rather than as absent", () => {
    // Negative control for the browser case: it would pass over a pane that rendered
    // the browser whatever its address said, which would make the builder
    // unreachable.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__scope-heading")).toHaveLength(0);
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("mounts both reserved bodies beneath the absence", () => {
    // The chrome renders children on its `ready` arm alone, so a pane that handed it
    // a `not-checked` STATE would drop these two silently — the read's absence would
    // render and the canvas and inspector would not.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
  });

  it("states that saving is unreachable rather than drawing a button that is not", () => {
    const section = renderPane(paneContext(ADDRESSED));
    const authoring = section.querySelector(".meridian-workflow__authoring");
    expect(authoring).not.toBeNull();
    expect(authoring?.querySelector("button")).toBeNull();
    expect(section.textContent ?? "").toContain("wire-unregistered");
  });

  it("puts phrasing content in the control strip, which is all a span may hold", () => {
    // `ConsolePaneChrome` renders `actions` inside `<span class="meridian-pane__controls">`,
    // and this pane passed a `<div>` — invalid HTML on every builder pane, reported by
    // neither tier: axe does not check content models, and the screenshot sees identical
    // pixels because the wrapper is already laid out `inline-flex`.
    const section = renderPane(paneContext(ADDRESSED));
    const controls = section.querySelector(".meridian-pane__controls");
    expect(controls).not.toBeNull();
    expect(controls?.querySelector(FLOW_ONLY_ELEMENTS.join(","))).toBeNull();
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

  it("mounts no body and offers no save for a subject it will not open", () => {
    // The refusal has to be the whole surface. A pane that refused in a banner and
    // still mounted its two slots would have composed the read the banner says it
    // did not, and would still offer to save it.
    const section = renderPane(paneContext(MISADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(0);
    expect(section.querySelector(".meridian-workflow__authoring")).toBeNull();
    expect(section.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });

  it("negative control: the same pane opens on the kind it does author", () => {
    // Without this, both cases above pass over a pane that refused every address,
    // which would make the builder unreachable rather than fail-closed.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
  });
});
