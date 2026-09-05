// The one crumb derivation, and the trail it draws.
//
// The claims that fail invisibly: a trail that drops a crumb the address carries says
// the pane is scoped to less than it is, a trail that renders a placeholder for one it
// does not says the opposite, and an empty strip reads as a breadcrumb that failed to
// render rather than as an address that names nothing.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    // Every id is DISTINCT on purpose: two crumbs sharing a string cannot witness "in
    // order", because the assertion holds over either arrangement. The colliding case
    // is a claim about KEYS rather than about order, and is made below.
    expect(
      paneScopeCrumbs({
        sessionId: "session-1",
        channelId: "channel-2",
        runId: "run-03",
        entity: { kind: "agent", id: "agent-04" },
      }),
    ).toStrictEqual([
      { scope: "session", value: "session-1" },
      { scope: "channel", value: "channel-2" },
      { scope: "run", value: "run-03" },
      { scope: "entity", value: "agent-04" },
    ]);
  });

  it("carries a distinct scope on every crumb, however the identifiers collide", () => {
    // THE FINDING. Nothing on the wire forbids two scopes of one address holding the
    // same string — a run whose id is its session's is the shape that reaches this
    // first — and the crumbs used to be bare identifiers, so the trail keyed sibling
    // `<li>` on a value that was not unique. The scope is unique BY CONSTRUCTION: an
    // address has at most one crumb per scope, so this cannot be defeated by any
    // arrangement of identifiers.
    const collided = paneScopeCrumbs({
      sessionId: "shared-id",
      channelId: "shared-id",
      runId: "shared-id",
      entity: { kind: "run", id: "shared-id" },
    });
    expect(collided.map((crumb) => crumb.value)).toStrictEqual([
      "shared-id",
      "shared-id",
      "shared-id",
      "shared-id",
    ]);
    const scopes = collided.map((crumb) => crumb.scope);
    expect(new Set(scopes).size, "two crumbs of one address share a scope").toBe(scopes.length);
    expect(scopes).toStrictEqual(["session", "channel", "run", "entity"]);
  });

  it("leaves out what the address does not carry", () => {
    expect(
      paneScopeCrumbs({
        sessionId: "session-1",
        channelId: undefined,
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
    ).toStrictEqual([{ scope: "entity", value: "agent-04" }]);
  });
});

/** Every React warning raised while `act` ran, so a keying fault is read rather than logged. */
function reactWarnings(): { readonly lines: () => readonly string[] } {
  const raised: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...parts: readonly unknown[]) => {
    raised.push(parts.map((part) => String(part)).join(" "));
  });
  return { lines: () => raised };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PaneBreadcrumb — two scopes may carry one identifier", () => {
  // WHERE THE PROOF ACTUALLY LIVES, stated because it is not where it first appears to.
  // The `console-unit` project declares no `setupFiles` and fails on no warning, so
  // React's duplicate-key report would be logged and never read — it is captured here
  // explicitly, and that capture is the case that fails on the pre-fix shape. The
  // rendered-outcome case below is NOT a second control: measured on the pinned React,
  // a duplicate key still renders both children and still updates the second by
  // position, so that case passes either way. Keying is a property of the derivation
  // (asserted above, where scope uniqueness is structural) and of what React is handed
  // (asserted here); it is deliberately not asserted through a misbehaviour React
  // documents as unpredictable and could change between versions.

  it("renders both crumbs and raises no duplicate-key warning", () => {
    const warnings = reactWarnings();
    const crumbs = renderTrail({
      sessionId: "shared-id",
      channelId: undefined,
      runId: "shared-id",
      entity: undefined,
    });
    // Two address crumbs plus the pane's own name. Before the fix React kept ONE of
    // the colliding pair, so this read two rather than three.
    expect(crumbTexts(crumbs)).toStrictEqual(["shared-id", "shared-id", "Inspector"]);
    expect(warnings.lines().filter((line) => /same key/u.test(line))).toStrictEqual([]);
  });

  it("negative control: the warning capture is wired, and reads a real duplicate key", () => {
    // Without this the claim above passes over a spy that never saw anything — the
    // failure this class of assertion is most prone to. A list keyed on a repeated
    // value is exactly the pre-fix shape, planted here rather than described.
    const warnings = reactWarnings();
    render(
      <ol>
        {["shared-id", "shared-id"].map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ol>,
    );
    expect(warnings.lines().filter((line) => /same key/u.test(line)).length).toBeGreaterThan(0);
  });

  it("moves the right crumb when one scope of a colliding pair changes", () => {
    // The OUTCOME the key exists to protect, pinned separately from the key itself.
    // React documents its behaviour on duplicate keys as unpredictable, and measured
    // on the version this console pins it keeps both children and reconciles the
    // second by position — so this case passes on the pre-fix shape too, and it is
    // NOT the control for the finding. It is here because "the trail shows the new run
    // id in the run's place" is what a reader needs to stay true whatever a future
    // reconciler does with a duplicate, and nothing else asserts it.
    const shared: PaneScopeAddress = {
      sessionId: "shared-id",
      channelId: undefined,
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
