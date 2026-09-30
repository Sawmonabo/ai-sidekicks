// The crumb derivation and the trail it draws. Failures here are invisible: a dropped crumb,
// a placeholder for a missing one, or an empty strip that reads as a render failure.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { duplicateKeyReports, reportsWhileReactRan } from "@test/helpers/react-reports.js";
import { PaneBreadcrumb, paneScopeCrumbs, type PaneScopeAddress } from "./PaneBreadcrumb.js";

const NO_ADDRESS: PaneScopeAddress = {
  sessionId: undefined,
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
  it("orders the crumbs session, run, entity", () => {
    // Ids are distinct here so order can be witnessed; colliding ids are a key claim, made below.
    expect(
      paneScopeCrumbs({
        sessionId: "session-1",
        runId: "run-03",
        entity: { kind: "agent", id: "agent-04" },
      }),
    ).toStrictEqual([
      { scope: "session", value: "session-1" },
      { scope: "run", value: "run-03" },
      { scope: "entity", value: "agent-04" },
    ]);
  });

  it("carries a distinct scope on every crumb, however the identifiers collide", () => {
    // Two scopes may hold one string (a run whose id is its session's); the scope key is unique
    // by construction, whatever the identifiers.
    const collided = paneScopeCrumbs({
      sessionId: "shared-id",
      runId: "shared-id",
      entity: { kind: "run", id: "shared-id" },
    });
    expect(collided.map((crumb) => crumb.value)).toStrictEqual([
      "shared-id",
      "shared-id",
      "shared-id",
    ]);
    const scopes = collided.map((crumb) => crumb.scope);
    expect(new Set(scopes).size, "two crumbs of one address share a scope").toBe(scopes.length);
    expect(scopes).toStrictEqual(["session", "run", "entity"]);
  });

  it("leaves out what the address does not carry", () => {
    expect(
      paneScopeCrumbs({
        sessionId: "session-1",
        runId: undefined,
        entity: { kind: "run", id: "run-10" },
      }),
    ).toStrictEqual([
      { scope: "session", value: "session-1" },
      { scope: "entity", value: "run-10" },
    ]);
  });

  it("answers nothing for an address that names nothing", () => {
    expect(paneScopeCrumbs(NO_ADDRESS)).toStrictEqual([]);
  });

  it("negative control: the derivation reads its argument", () => {
    // Negative control: a helper answering a fixed list would pass both cases above.
    expect(paneScopeCrumbs({ ...NO_ADDRESS, sessionId: "session-1" })).not.toStrictEqual(
      paneScopeCrumbs(NO_ADDRESS),
    );
  });

  it("negative control: an entity contributes its id and not its kind", () => {
    // The kind is already said by the glyph and the pane's own crumb.
    expect(
      paneScopeCrumbs({ ...NO_ADDRESS, entity: { kind: "agent", id: "agent-04" } }),
    ).toStrictEqual([{ scope: "entity", value: "agent-04" }]);
  });
});

describe("PaneBreadcrumb — two scopes may carry one identifier", () => {
  // The duplicate-key warning is only logged, so it is captured explicitly here; that capture is
  // the case that fails on a duplicate key. The rendered-outcome case below passes either way,
  // since React's duplicate-key behavior is unspecified. Keying is asserted on the derivation and
  // on what React is handed.

  it("renders both crumbs and raises no duplicate-key warning", async () => {
    const { value: crumbs, reported } = await reportsWhileReactRan(() =>
      renderTrail({
        sessionId: "shared-id",
        runId: "shared-id",
        entity: undefined,
      }),
    );
    // Two address crumbs plus the pane's name; a duplicate key would keep only one of the pair.
    expect(crumbTexts(crumbs)).toStrictEqual(["shared-id", "shared-id", "Inspector"]);
    expect(duplicateKeyReports(reported)).toStrictEqual([]);
  });

  it("negative control: the warning capture is wired, and reads a real duplicate key", async () => {
    // Negative control: the capture must see a real duplicate key, or the claim above is vacuous.
    const { reported } = await reportsWhileReactRan(() =>
      render(
        <ol>
          {["shared-id", "shared-id"].map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ol>,
      ),
    );
    expect(duplicateKeyReports(reported).length).toBeGreaterThan(0);
  });

  it("moves the right crumb when one scope of a colliding pair changes", () => {
    // The outcome the key protects: the new run id shows in the run's place. This passes even with
    // a duplicate key, so it is not the control for the key.
    const shared: PaneScopeAddress = {
      sessionId: "shared-id",
      runId: "shared-id",
      entity: undefined,
    };
    const { container, rerender } = render(
      <PaneBreadcrumb {...shared} crumbsId={CRUMBS_ID} currentCrumb="Inspector" />,
    );
    rerender(
      <PaneBreadcrumb {...shared} runId="run-99" crumbsId={CRUMBS_ID} currentCrumb="Inspector" />,
    );
    const crumbs = container.querySelector(".meridian-pane__crumbs");
    if (!(crumbs instanceof HTMLElement)) {
      throw new Error("the breadcrumb rendered no crumb list");
    }
    expect(crumbTexts(crumbs)).toStrictEqual(["shared-id", "run-99", "Inspector"]);
  });
});

describe("PaneBreadcrumb — the trail", () => {
  it("renders the address in order and ends on the pane's own name", () => {
    const crumbs = renderTrail(
      {
        sessionId: "session-1",
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
      // Exactly one crumb is current, and it is the last.
      .toStrictEqual(["Runs"]);
  });

  it("negative control: a leading crumb is not marked current", () => {
    // Negative control: a trail marking every crumb current would pass the case above.
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    const listed = [...crumbs.querySelectorAll("li")];
    expect(listed[0]?.getAttribute("aria-current")).toBeNull();
    expect(listed.at(-1)?.getAttribute("aria-current")).toBe("page");
  });

  it("says the address names nothing rather than rendering an empty strip", () => {
    const crumbs = renderTrail(NO_ADDRESS, "Transcript");
    expect(crumbs.querySelector(".meridian-pane__crumb-absent")?.textContent).toBe("No session");
    expect(crumbTexts(crumbs)).toStrictEqual(["No session", "Transcript"]);
  });

  it("negative control: an address that names something draws no absent crumb", () => {
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Transcript");
    expect(crumbs.querySelector(".meridian-pane__crumb-absent")).toBeNull();
  });

  it("wears the provenance signature on every wire crumb and on no prose one", () => {
    // Wire ids render mono; the pane's own prose name must not borrow that signature.
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Transcript");
    const figures = [...crumbs.querySelectorAll(".meridian-figure--wire")].map(
      (figure) => figure.textContent,
    );
    expect(figures).toStrictEqual(["session-1"]);
  });

  it("carries the id the pane names itself by, on the list and not on a crumb", () => {
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    expect(crumbs.id).toBe(CRUMBS_ID);
    // The whole trail is the name; the last crumb's id alone would name every pane alike.
    expect(crumbs.textContent).toContain("session-1");
    expect(crumbs.textContent).toContain("Runs");
  });

  it("separates crumbs with a mark no reader announces", () => {
    // A titleless `Glyph` is `aria-hidden`; generated content would be read out by some readers.
    const crumbs = renderTrail({ ...NO_ADDRESS, sessionId: "session-1" }, "Runs");
    const separators = [...crumbs.querySelectorAll("svg")];
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});
