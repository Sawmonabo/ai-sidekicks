// The one crumb derivation, and the trail it draws.
//
// The claims that fail invisibly: a trail that drops a crumb the address carries says
// the pane is scoped to less than it is, a trail that renders a placeholder for one it
// does not says the opposite, and an empty strip reads as a breadcrumb that failed to
// render rather than as an address that names nothing.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaneBreadcrumb, paneScopeCrumbs, type PaneScopeAddress } from "./PaneBreadcrumb.js";

const NO_ADDRESS: PaneScopeAddress = {
  sessionId: undefined,
  channelId: undefined,
  runId: undefined,
  entity: undefined,
};

const CRUMBS_ID = "pane-heading-1";

function renderTrail(address: PaneScopeAddress, currentCrumb = "Inspector"): HTMLElement {
  const { container } = render(
    <PaneBreadcrumb {...address} crumbsId={CRUMBS_ID} currentCrumb={currentCrumb} />,
  );
  const crumbs = container.querySelector(".meridian-pane__crumbs");
  if (!(crumbs instanceof HTMLElement)) {
    throw new Error("the breadcrumb rendered no crumb list");
  }
  return crumbs;
}

function crumbTexts(crumbs: HTMLElement): readonly (string | null)[] {
  return [...crumbs.querySelectorAll("li")].map((crumb) => crumb.textContent);
}

describe("paneScopeCrumbs — what the address carries, and nothing else", () => {
  it("orders the crumbs session, channel, run, entity", () => {
    // Every id is DISTINCT on purpose. Two crumbs sharing a string cannot witness "in
    // order" — the assertion holds over either arrangement — and the trail keys each
    // crumb by its own text, so a repeated one is also a duplicate React key.
    expect(
      paneScopeCrumbs({
        sessionId: "session-1",
        channelId: "channel-2",
        runId: "run-03",
        entity: { kind: "agent", id: "agent-04" },
      }),
    ).toStrictEqual(["session-1", "channel-2", "run-03", "agent-04"]);
  });

  it("leaves out what the address does not carry", () => {
    expect(
      paneScopeCrumbs({
        sessionId: "session-1",
        channelId: undefined,
        runId: undefined,
        entity: { kind: "run", id: "run-10" },
      }),
    ).toStrictEqual(["session-1", "run-10"]);
  });

  it("answers nothing for an address that names nothing", () => {
    expect(paneScopeCrumbs(NO_ADDRESS)).toStrictEqual([]);
  });

  it("negative control: the derivation reads its argument", () => {
    // Without this, both cases above would also pass over a helper that answered a
    // fixed list, and the absent arm below would be the only thing ever exercised.
    expect(paneScopeCrumbs({ ...NO_ADDRESS, sessionId: "session-1" })).not.toStrictEqual(
      paneScopeCrumbs(NO_ADDRESS),
    );
  });

  it("negative control: an entity contributes its id and not its kind", () => {
    // The kind is already said by the pane's glyph and its own crumb, and `agent
    // agent-04` in the trail would be the console saying it twice in two registers.
    expect(
      paneScopeCrumbs({ ...NO_ADDRESS, entity: { kind: "agent", id: "agent-04" } }),
    ).toStrictEqual(["agent-04"]);
  });
});

describe("PaneBreadcrumb — the trail", () => {
  it("renders the address in order and ends on the pane's own name", () => {
    const crumbs = renderTrail(
      {
        sessionId: "session-1",
        channelId: undefined,
        runId: "run-01",
        entity: { kind: "agent", id: "agent-01" },
      },
      "Inspector",
    );
    expect(crumbTexts(crumbs)).toStrictEqual(["session-1", "run-01", "agent-01", "Inspector"]);
  });

  it("marks the pane's own crumb as the current one, and no other", () => {
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    expect([...crumbs.querySelectorAll('[aria-current="page"]')].map((el) => el.textContent))
      // The trail is where you ARE, so exactly one crumb is current and it is the last.
      .toStrictEqual(["Runs"]);
  });

  it("negative control: a leading crumb is not marked current", () => {
    // Without this the case above would pass over a trail that marked every crumb: a
    // one-element result read out of a longer list is only evidence if the extra
    // entries are the thing claimed absent.
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    const listed = [...crumbs.querySelectorAll("li")];
    expect(listed[0]?.getAttribute("aria-current")).toBeNull();
    expect(listed.at(-1)?.getAttribute("aria-current")).toBe("page");
  });

  it("says the address names nothing rather than rendering an empty strip", () => {
    const crumbs = renderTrail(NO_ADDRESS, "Timeline");
    expect(crumbs.querySelector(".meridian-pane__crumb-absent")?.textContent).toBe("No session");
    expect(crumbTexts(crumbs)).toStrictEqual(["No session", "Timeline"]);
  });

  it("negative control: an address that names something draws no absent crumb", () => {
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Timeline");
    expect(crumbs.querySelector(".meridian-pane__crumb-absent")).toBeNull();
  });

  it("wears the provenance signature on every wire crumb and on no prose one", () => {
    // Rule 4: an id came off the wire and renders mono; the pane's own name is prose
    // this console wrote and must not borrow the signature that says otherwise.
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Timeline");
    const figures = [...crumbs.querySelectorAll(".meridian-figure--wire")].map(
      (figure) => figure.textContent,
    );
    expect(figures).toStrictEqual(["session-1"]);
  });

  it("carries the id the pane names itself by, on the list and not on a crumb", () => {
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    expect(crumbs.id).toBe(CRUMBS_ID);
    // The whole trail is the name. An id on the last crumb alone would name every runs
    // pane in a deck "Runs".
    expect(crumbs.textContent).toContain("session-1");
    expect(crumbs.textContent).toContain("Runs");
  });

  it("separates crumbs with a mark no reader announces", () => {
    // `Glyph` with no `title` is `aria-hidden` by its own contract. Generated content
    // would look the same and be read out by the assistive technology that reads it.
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    const separators = [...crumbs.querySelectorAll("svg")];
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});
