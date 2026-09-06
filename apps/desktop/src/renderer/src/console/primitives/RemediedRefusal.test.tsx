// The join between a refusal and the console's move: which shape, and whose words.
//
// The three claims worth a test are the three ways this could quietly go wrong. It
// could paraphrase — so every case asserts the daemon's own sentence survives beside
// whatever the table added. It could draw a banner inside a pane — so the `banner`
// rendering is asserted to draw the card, the escalation being a separate act by a
// surface that holds a frame store. And it could invent a move for a code the table
// does not answer for — so the unlisted code is asserted to render exactly what it
// renders without this component at all.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, refusalRemedyFor } from "../core/index.js";
import { RemediedRefusal } from "./RemediedRefusal.js";

const GONE_SESSION = refuse("runs", "session.not_found", "That session is not on this node.");
const ALREADY_SENT = refuse(
  "run-control",
  "intervention.idempotency_conflict",
  "That key was already spent on different text.",
);
const UNLISTED = refuse("runs", "driver.capability_unsupported", "This driver cannot rewind.");

function renderRefusal(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const shape = container.firstElementChild;
  if (!(shape instanceof HTMLElement)) {
    throw new Error("RemediedRefusal rendered no element");
  }
  return shape;
}

describe("the shape a remedied refusal takes", () => {
  it("draws the card for a card-rendered code", () => {
    const shape = renderRefusal(
      <RemediedRefusal
        refusal={refuse("approvals", "approval.already_resolved", "Answered elsewhere.")}
      />,
    );

    expect(shape.className).toContain("meridian-refusal--card");
  });

  it("draws the CARD for a banner-rendered code, never a banner inside a pane", () => {
    // The escalation is `store/refusal-escalation.ts`'s job. A pane drawing the
    // frame's banner would put a whole-room notice inside one pane, and this
    // component is pure and holds no frame store to hand it to.
    const shape = renderRefusal(<RemediedRefusal refusal={GONE_SESSION} />);

    expect(shape.className).toContain("meridian-refusal--card");
    expect(shape.className).not.toContain("meridian-refusal--banner");
  });

  it("draws inline for an inline-rendered code", () => {
    const shape = renderRefusal(<RemediedRefusal refusal={ALREADY_SENT} />);

    expect(shape.className).toContain("meridian-refusal--inline");
  });

  it("draws inline for a code the table does not answer for", () => {
    const shape = renderRefusal(<RemediedRefusal refusal={UNLISTED} />);

    expect(shape.className).toContain("meridian-refusal--inline");
  });
});

describe("whose words reach the screen", () => {
  it("keeps the daemon's code and sentence, and adds the console's move beside them", () => {
    const shape = renderRefusal(<RemediedRefusal refusal={ALREADY_SENT} />);

    expect(shape.textContent).toContain(ALREADY_SENT.code);
    expect(shape.textContent).toContain(ALREADY_SENT.detail);
    expect(shape.textContent).toContain(refusalRemedyFor(ALREADY_SENT.code)?.nextMove);
  });

  it("puts the move in the action slot, so nothing edits the daemon's message", () => {
    const shape = renderRefusal(<RemediedRefusal refusal={ALREADY_SENT} />);
    const message = shape.querySelector(".meridian-refusal__message");

    expect(message?.textContent).toBe(ALREADY_SENT.detail);
    expect(shape.querySelector(".meridian-refusal__next-move")).not.toBeNull();
  });

  it("offers no action at all for an unlisted code", () => {
    // The honest default, and the negative control for the whole table: a code with
    // no registered move renders what the daemon said and nothing else.
    const shape = renderRefusal(<RemediedRefusal refusal={UNLISTED} />);

    expect(shape.textContent).toContain(UNLISTED.detail);
    expect(shape.querySelector(".meridian-refusal__action")).toBeNull();
    expect(shape.querySelector(".meridian-refusal__next-move")).toBeNull();
  });
});

describe("what a surface can say that the table cannot", () => {
  it("renders the caller's own detail after the console's move", () => {
    const shape = renderRefusal(
      <RemediedRefusal refusal={ALREADY_SENT} detailAction={<em>binding-a</em>} />,
    );
    const action = shape.querySelector(".meridian-refusal__action");

    expect(action?.textContent).toContain(refusalRemedyFor(ALREADY_SENT.code)?.nextMove);
    expect(action?.textContent).toContain("binding-a");
  });

  it("opens the action slot for a caller's detail even where the table answers nothing", () => {
    const shape = renderRefusal(
      <RemediedRefusal refusal={UNLISTED} detailAction={<em>binding-a</em>} />,
    );

    expect(shape.querySelector(".meridian-refusal__action")?.textContent).toBe("binding-a");
    expect(shape.querySelector(".meridian-refusal__next-move")).toBeNull();
  });
});
