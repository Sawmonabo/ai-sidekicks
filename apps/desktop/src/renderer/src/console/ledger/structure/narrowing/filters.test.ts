// Filters and jumps, and the one rule here that is not a convenience.
//
// The boundary rule — "a filtered subscription still receives
// `rollback_boundary` rows for any run whose rows the filter admits" — is the
// case that fails silently and expensively: a filter that dropped the boundary
// while keeping its run's rows renders a history that had been corrected as
// though it never was. It gets a positive case AND the negative control that
// distinguishes it from simply never filtering boundaries at all.
//
// The pane's own CHANNEL scope is a different subject and lives in
// `filters.channel-scope.test.ts`: a facet is a narrowing a reader applies to a
// window, and a channel scope is what the window is a log OF.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  UNFILTERED_LEDGER,
  applyLedgerFilter,
  deriveLedgerFacets,
  isLedgerFiltered,
  jumpToEventId,
  type LedgerJumpStages,
  withToggledCategory,
  withToggledParticipant,
} from "./filters.js";
import { generalRow, rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";

/** Two runs by two agents, one session row, and a boundary in each run. */
function twoRunWindow(): readonly TimelineRow[] {
  return [
    runRow({
      id: "a1",
      sequence: 1,
      type: "run.running",
      runId: "run-a",
      position: 1,
      actor: "agent-one",
    }),
    runRow({
      id: "b1",
      sequence: 2,
      type: "run.running",
      runId: "run-b",
      position: 1,
      actor: "agent-two",
    }),
    generalRow({
      id: "s1",
      sequence: 3,
      type: "session.renamed",
      category: "session_lifecycle",
      actor: "person-one",
    }),
    // Both boundaries carry an actor the participant filters below exclude, which
    // is what makes their admission a rule about the RUN rather than about who
    // pressed the button.
    rollbackBoundaryRow({
      id: "rb-a",
      sequence: 4,
      runId: "run-a",
      position: 2,
      targetPosition: 1,
      actor: "person-one",
    }),
    rollbackBoundaryRow({
      id: "rb-b",
      sequence: 5,
      runId: "run-b",
      position: 2,
      targetPosition: 1,
      actor: "person-one",
    }),
    runRow({
      id: "a2",
      sequence: 6,
      type: "run.completed",
      runId: "run-a",
      position: 3,
      actor: "agent-one",
    }),
  ];
}

function visibleIds(rows: readonly TimelineRow[]): readonly string[] {
  return rows.map((row) => row.id);
}

describe("filters — the unfiltered ledger narrows nothing", () => {
  it("reports itself unfiltered and hands the window straight back", () => {
    const rows = twoRunWindow();
    expect(isLedgerFiltered(UNFILTERED_LEDGER)).toBe(false);
    expect(applyLedgerFilter(rows, UNFILTERED_LEDGER)).toBe(rows);
  });

  it("negative control: either axis alone makes it filtered", () => {
    expect(isLedgerFiltered({ participantIds: ["agent-one"], categories: [] })).toBe(true);
    expect(isLedgerFiltered({ participantIds: [], categories: ["run_lifecycle"] })).toBe(true);
  });
});

describe("filters — the two axes", () => {
  it("admits one participant's rows", () => {
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: ["agent-one"],
      categories: [],
    });
    // `a1` and `a2` on their own merits; `rb-a` by the boundary rule below.
    expect(visibleIds(visible)).toStrictEqual(["a1", "rb-a", "a2"]);
  });

  it("negative control: a participant nobody in the window carries admits nothing", () => {
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: ["an-agent-that-never-joined"],
      categories: [],
    });
    expect(visible).toStrictEqual([]);
  });

  it("admits one event family", () => {
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: [],
      categories: ["session_lifecycle"],
    });
    expect(visibleIds(visible)).toStrictEqual(["s1"]);
  });

  it("intersects the two axes rather than uniting them", () => {
    // A filter that unioned would show `s1` here, because its category matches
    // even though its actor does not.
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: ["agent-one"],
      categories: ["session_lifecycle"],
    });
    expect(visibleIds(visible)).toStrictEqual([]);
  });

  it("narrows without ever re-ordering", () => {
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: ["agent-one", "agent-two"],
      categories: [],
    });
    const sequences = visible.map((row) => row.sequence);
    expect([...sequences].sort((left, right) => left - right)).toStrictEqual(sequences);
  });
});

describe("filters — a boundary survives for a run the filter admits", () => {
  it("re-admits the rollback boundary of an admitted run, whoever pressed it", () => {
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: ["agent-one"],
      categories: [],
    });
    expect(visibleIds(visible)).toContain("rb-a");
  });

  it("negative control: the boundary of a run the filter excludes stays hidden", () => {
    // Without this the rule above would be indistinguishable from never filtering
    // boundaries at all, which would leak another run's corrections into a view
    // narrowed to one agent.
    const visible = applyLedgerFilter(twoRunWindow(), {
      participantIds: ["agent-one"],
      categories: [],
    });
    expect(visibleIds(visible)).not.toContain("rb-b");
  });

  it("admits a boundary that arrived BEFORE any admitted row of its run", () => {
    // The reason the fold is two passes: judged in one, this boundary would be
    // decided before its run was known to be admitted.
    const visible = applyLedgerFilter(
      [
        rollbackBoundaryRow({
          id: "rb",
          sequence: 1,
          runId: "run-a",
          position: 1,
          actor: "person-one",
        }),
        runRow({
          id: "a1",
          sequence: 2,
          type: "run.running",
          runId: "run-a",
          position: 2,
          actor: "agent-one",
        }),
      ],
      { participantIds: ["agent-one"], categories: [] },
    );
    expect(visibleIds(visible)).toStrictEqual(["rb", "a1"]);
  });
});

describe("filters — the menu is derived from the window, never from a hand-written list", () => {
  it("offers each value present, with the count that makes it a choice", () => {
    const facets = deriveLedgerFacets(twoRunWindow());
    expect(facets.participants).toStrictEqual([
      { value: "agent-one", rowCount: 2 },
      { value: "agent-two", rowCount: 1 },
      { value: "person-one", rowCount: 3 },
    ]);
    expect(facets.categories).toStrictEqual([
      { value: "run_lifecycle", rowCount: 5 },
      { value: "session_lifecycle", rowCount: 1 },
    ]);
  });

  it("negative control: a family with no rows in this window is not offered", () => {
    // A menu of twenty categories, eighteen of which match nothing, is a menu
    // nobody reads — and a `tool_activity` entry that filters to zero rows is
    // exactly that.
    const offered = deriveLedgerFacets(twoRunWindow()).categories.map((facet) => facet.value);
    expect(offered).not.toContain("tool_activity");
    expect(offered).not.toContain("usage_telemetry");
  });

  it("negative control: an empty window offers nothing", () => {
    expect(deriveLedgerFacets([])).toStrictEqual({ participants: [], categories: [] });
  });
});

describe("filters — jump by id names which narrowing is hiding the row", () => {
  const rows = twoRunWindow();
  const narrowed = applyLedgerFilter(rows, { participantIds: ["agent-one"], categories: [] });

  /**
   * The four stages, each admitting whatever it is handed.
   *
   * Built from row lists rather than from a window model, because the classifier's
   * whole claim is that it answers from the STAGES and not from either end of
   * them — a case that had to build a feed to exercise one arm would be testing
   * the feed.
   */
  function stagesOver(admissions: {
    filter?: readonly TimelineRow[];
    fold?: readonly TimelineRow[];
    replay?: readonly TimelineRow[];
    viewport?: readonly TimelineRow[];
  }): LedgerJumpStages {
    const idsOf = (admitted: readonly TimelineRow[] | undefined): ReadonlySet<string> =>
      new Set((admitted ?? rows).map((row) => row.id));
    return {
      "hidden-by-filter": idsOf(admissions.filter),
      "folded-into-chapter": idsOf(admissions.fold),
      "withheld-by-replay": idsOf(admissions.replay),
      "outside-window": idsOf(admissions.viewport),
    };
  }

  it("finds a row every stage admitted", () => {
    expect(jumpToEventId(rows, stagesOver({}), "a1").status).toBe("found");
  });

  it("names the filter for a row the narrowing dropped", () => {
    expect(jumpToEventId(rows, stagesOver({ filter: narrowed }), "b1").status).toBe(
      "hidden-by-filter",
    );
  });

  it("names the chapter fold, the replay and the cap, each for its own stage", () => {
    // The three arms that used to be reported as the filter's. Each stage is the
    // only one narrowed in its case, so the answer can come from nowhere else.
    const foldedAway = rows.filter((row) => row.id !== "b1");
    expect(jumpToEventId(rows, stagesOver({ fold: foldedAway }), "b1").status).toBe(
      "folded-into-chapter",
    );
    expect(jumpToEventId(rows, stagesOver({ replay: foldedAway }), "b1").status).toBe(
      "withheld-by-replay",
    );
    expect(jumpToEventId(rows, stagesOver({ viewport: foldedAway }), "b1").status).toBe(
      "outside-window",
    );
  });

  it("names the earliest stage that dropped the row, not the last", () => {
    // The stages nest, so a row the filter dropped is absent from every stage after
    // it. Reading the last would report the cap for a row a narrowing removed —
    // and offer an act that does nothing about the filter still on the ledger.
    const withoutB1 = rows.filter((row) => row.id !== "b1");
    const outcome = jumpToEventId(
      rows,
      stagesOver({ filter: withoutB1, fold: withoutB1, replay: withoutB1, viewport: withoutB1 }),
      "b1",
    );
    expect(outcome.status).toBe("hidden-by-filter");
  });

  it("separates an id this window never held from every narrowing", () => {
    expect(jumpToEventId(rows, stagesOver({}), "an-id-from-earlier-in-the-session").status).toBe(
      "not-in-loaded-log",
    );
  });

  it("negative control: with every stage admitting everything nothing is ever absent", () => {
    // Without this the cases above would pass over a classifier that reported an
    // absence for every id, which would put a permanent notice on a whole ledger.
    for (const row of rows) {
      expect(jumpToEventId(rows, stagesOver({}), row.id).status).toBe("found");
    }
  });
});

describe("filters — a facet press narrows, and pressing it again widens back", () => {
  it("admits a participant, then releases the same one", () => {
    const narrowed = withToggledParticipant(UNFILTERED_LEDGER, "agent-one");
    expect(narrowed.participantIds).toStrictEqual(["agent-one"]);
    expect(withToggledParticipant(narrowed, "agent-one")).toStrictEqual(UNFILTERED_LEDGER);
  });

  it("keeps the two axes independent", () => {
    const narrowed = withToggledCategory(
      withToggledParticipant(UNFILTERED_LEDGER, "agent-one"),
      "run_lifecycle",
    );
    expect(narrowed).toStrictEqual({
      participantIds: ["agent-one"],
      categories: ["run_lifecycle"],
    });
    // Negative control: releasing one axis leaves the other narrowed. A toggle that
    // rebuilt the whole value would have cleared both and reported success.
    expect(withToggledCategory(narrowed, "run_lifecycle").participantIds).toStrictEqual([
      "agent-one",
    ]);
  });

  it("admits more than one value on an axis", () => {
    const narrowed = withToggledParticipant(
      withToggledParticipant(UNFILTERED_LEDGER, "agent-one"),
      "agent-two",
    );
    expect(narrowed.participantIds).toStrictEqual(["agent-one", "agent-two"]);
    // Both runs' rows, both runs' boundaries, and the session row left out.
    expect(applyLedgerFilter(twoRunWindow(), narrowed).map((row) => row.id)).toStrictEqual([
      "a1",
      "b1",
      "rb-a",
      "rb-b",
      "a2",
    ]);
  });
});
