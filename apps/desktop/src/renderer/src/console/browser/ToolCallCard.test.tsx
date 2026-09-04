// The tool-call card is measured by what it refuses to become: a second approval
// surface, and a second opinion about whether a call would be allowed.
//
// So the clean cases assert the governance facts the card states by construction,
// and the negative controls assert the two controls and the one derivation that
// would be there if the card had drifted into either role.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { BrowserToolCallCard, type BrowserToolCallCardProps } from "./ToolCallCard.js";

const BASE: BrowserToolCallCardProps = {
  toolCallId: "call-7be2",
  toolName: "page.click",
  argumentsJson: '{"selector":"button[type=submit]"}',
  owningRunLabel: "Check the staging build",
  outcome: { status: "awaiting-adjudication" },
};

function renderCall(props: BrowserToolCallCardProps): HTMLElement {
  const { container } = render(<BrowserToolCallCard {...props} />);
  const card = container.querySelector("article");
  if (!(card instanceof HTMLElement)) {
    throw new Error("BrowserToolCallCard rendered no card");
  }
  return card;
}

describe("tool-call card — the row itself", () => {
  it("names the tool wire-verbatim, and the run that owns the page", () => {
    const card = renderCall(BASE);
    expect(card.getAttribute("aria-label")).toContain("page.click");
    const monoText = [...card.querySelectorAll(".meridian-figure--wire")]
      .map((node) => node.textContent ?? "")
      .join(" ");
    expect(monoText).toContain("page.click");
    expect(card.textContent).toContain("Check the staging build");
  });

  it("keeps the arguments one click away rather than on the line", () => {
    const card = renderCall(BASE);
    const disclosure = card.querySelector("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(disclosure?.textContent).toContain("button[type=submit]");
  });

  it("negative control: the arguments are not also on the collapsed line", () => {
    // Without this, the case above would pass over a card that rendered the JSON
    // twice — once in the disclosure and once in the row body.
    const card = renderCall(BASE);
    const disclosure = card.querySelector("details");
    disclosure?.remove();
    expect(card.textContent).not.toContain("button[type=submit]");
  });
});

describe("tool-call card — governance, stated by construction", () => {
  it("names the approval category and the recovery floor", () => {
    const text = renderCall(BASE).textContent ?? "";
    expect(text).toContain("tool_execution");
    expect(text).toContain("manual_reconcile_only");
  });

  it("says the floor cannot be lifted here, not merely that it is not", () => {
    expect(renderCall(BASE).textContent).toContain("no surface on this node can lift");
  });

  it("negative control: it offers no approve and no reject", () => {
    // Approval cards live in the approvals surface. A second pair of controls here
    // would be a second path to one adjudication, which is the defect this case
    // exists to catch.
    const card = renderCall(BASE);
    const labels = [...card.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).not.toContain("Approve");
    expect(labels).not.toContain("Reject");
    expect(labels).toStrictEqual([]);
  });
});

describe("tool-call card — the outcomes", () => {
  it("says the call is with the daemon while it is being adjudicated", () => {
    const card = renderCall(BASE);
    const absence = card.querySelector(".meridian-nothing--computing");
    expect(absence).not.toBeNull();
    expect(absence?.textContent).toContain("With the daemon");
    // A badge has no room for a second line and carries it as its own tooltip —
    // the honest limit of that shape, and where the sentence has to be read from.
    expect(card.querySelector(".meridian-nothing__badge-label")?.getAttribute("title")).toContain(
      "does not predict the answer",
    );
  });

  it("renders a refusal verbatim and names the axis the daemon named", () => {
    const card = renderCall({
      ...BASE,
      outcome: {
        status: "refused",
        refusal: refuse("posture", "approval.denied", "This run may reach no network destination."),
        refusedAxis: "networkAccess",
      },
    });
    expect(card.textContent).toContain("approval.denied");
    expect(card.textContent).toContain("This run may reach no network destination");
    expect(card.textContent).toContain("networkAccess");
  });

  it("names no axis where the daemon named none", () => {
    const card = renderCall({
      ...BASE,
      outcome: {
        status: "refused",
        refusal: refuse("cedar", "approval.denied", "Policy denies this action for this agent."),
      },
    });
    expect(card.textContent).toContain("Policy denies this action");
    expect(card.textContent).not.toContain("Refused on");
  });

  it("reports an unchecked read-only claim as unchecked", () => {
    const proved = renderCall({ ...BASE, readOnlyEvidence: "engine-proved" });
    expect(proved.textContent).toContain("Read-only, proved");
    const unchecked = renderCall({ ...BASE, readOnlyEvidence: "unchecked" });
    expect(unchecked.textContent).toContain("Read-only, unchecked");
    expect(unchecked.querySelector(".meridian-chip--attention")).not.toBeNull();
  });

  it("negative control: an unchecked claim is not rendered as an established one", () => {
    // "Read-only" alone would assert what the engine could not prove, which is the
    // one thing the tool's own result refuses to do.
    const unchecked = renderCall({ ...BASE, readOnlyEvidence: "unchecked" });
    expect(unchecked.textContent).not.toContain("Read-only, proved");
    const none = renderCall(BASE);
    expect(none.textContent).not.toContain("Read-only");
  });
});
