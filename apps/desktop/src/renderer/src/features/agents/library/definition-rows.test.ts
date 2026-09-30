// The registry projection: what a row says, in what order, and what it refuses to turn an
// absence into. A silently dropped axis, an order taken from the daemon's iteration, and an
// allowlist of `null` rendered as "no tools" all look fine on screen, so each is asserted
// against the real projection with a negative control.

import { describe, expect, it } from "vitest";

import type { AgentProviderBinding, ProviderAccountId } from "@ai-sidekicks/contracts";
import { definition } from "./agent-library.test-support.js";
import {
  NO_SAVED_DEFINITIONS,
  describeDefinitionSettlement,
  describeDeletionQuestion,
  projectDefinitionRows,
  readDefinitions,
} from "./definition-rows.js";

describe("the registry projection — what a row carries", () => {
  it("reads the driver, model, account and effort off the default binding", () => {
    // A definition may carry a binding per further provider; the row says what it runs on when
    // no driver is named, which is the default and never an override.
    const codexOverride: AgentProviderBinding = {
      driverName: "codex",
      modelId: "gpt-5.6",
      providerAccountId: "account-home" as ProviderAccountId,
      effort: "low",
    };
    const record = definition();
    const [row] = projectDefinitionRows([
      { ...record, bindings: { ...record.bindings, overrides: [codexOverride] } },
    ]);
    const readings = ["driver", "model", "account", "effort"].map(
      (key) => row?.axes.find((axis) => axis.key === key)?.reading,
    );
    expect(readings).toStrictEqual(["claude", "claude-opus-4-6", "account-work", "high"]);
    expect(new Set(row?.axes.map((axis) => axis.key)).size).toBe(row?.axes.length);
  });

  it("carries the identity and the label as separate facts", () => {
    const [row] = projectDefinitionRows([definition({ name: "Reviewer" })]);
    expect(row?.definitionId).toBe("definition-1");
    expect(row?.name).toBe("Reviewer");
  });

  it("shows a pinned axis as the registry's own string", () => {
    const [row] = projectDefinitionRows([definition()]);
    const account = row?.axes.find((axis) => axis.key === "account");
    expect(account).toStrictEqual({
      key: "account",
      label: "Account",
      reading: "account-work",
      source: "wire",
    });
  });

  it("says whose default an unpinned axis takes, in the console's own voice", () => {
    // `null` is the materialized inherit state, and the sentence explaining it is ours;
    // rendering it as a wire figure would attribute our words to the daemon.
    const [row] = projectDefinitionRows([
      definition({
        defaultBinding: { providerAccountId: null, effort: null },
        executionPostureMode: null,
      }),
    ]);
    const unpinned = ["account", "effort", "posture"].map((key) =>
      row?.axes.find((axis) => axis.key === key),
    );
    expect(unpinned.map((axis) => axis?.source)).toStrictEqual(["console", "console", "console"]);
    expect(unpinned.map((axis) => axis?.reading)).toStrictEqual([
      "The provider's default",
      "The driver's default",
      "Not pinned",
    ]);
  });

  it("negative control: a pinned axis is not described as a default", () => {
    // Otherwise the case above would pass for a projection that ignored the value and always
    // said "default".
    const [row] = projectDefinitionRows([definition({ defaultBinding: { effort: "low" } })]);
    const effort = row?.axes.find((axis) => axis.key === "effort");
    expect(effort?.reading).toBe("low");
    expect(effort?.source).toBe("wire");
  });

  it("keeps the allowlist's three states three", () => {
    // `null` is the driver's defaults and `[]` is no tools at all. They read alike and mean
    // opposite things, so the stored shape keeps them apart.
    const readingFor = (allowlist: string[] | null): string | undefined =>
      projectDefinitionRows([definition({ toolAllowlist: allowlist })])[0]?.axes.find(
        (axis) => axis.key === "tools",
      )?.reading;
    expect(readingFor(null)).toBe("The driver's defaults");
    expect(readingFor([])).toBe("No tools");
    expect(readingFor(["read"])).toBe("1 tool");
    expect(readingFor(["read", "grep", "glob"])).toBe("3 tools");
  });

  it("reports whether there is prose, and never the prose itself", () => {
    // The text belongs to the editor; a clamped passage in a row would be one more rendering
    // of it.
    const [row] = projectDefinitionRows([
      definition({ instructions: "Be exact and terse.", goal: null }),
    ]);
    const instructions = row?.axes.find((axis) => axis.key === "instructions");
    const goal = row?.axes.find((axis) => axis.key === "goal");
    expect(instructions?.reading).toBe("Written");
    expect(goal?.reading).toBe("None");
    expect(row?.axes.map((axis) => axis.reading).join(" ")).not.toContain("Be exact and terse.");
  });

  it("carries both timestamps verbatim rather than through a clock format", () => {
    // The console's transcript clock format drops the date because a transcript has a day
    // divider; a saved record's instants span days and this list has none.
    const [row] = projectDefinitionRows([definition()]);
    expect(row?.axes.find((axis) => axis.key === "created")?.reading).toBe(
      "2026-01-01T10:00:00.000Z",
    );
    expect(row?.axes.find((axis) => axis.key === "updated")?.reading).toBe(
      "2026-01-02T11:30:00.000Z",
    );
  });
});

describe("the registry projection — the order", () => {
  it("sorts by name", () => {
    const rows = projectDefinitionRows(
      [
        definition({ definitionId: "definition-c", name: "Writer" }),
        definition({ definitionId: "definition-a", name: "Auditor" }),
        definition({ definitionId: "definition-b", name: "Reviewer" }),
      ],
      "en",
    );
    expect(rows.map((row) => row.name)).toStrictEqual(["Auditor", "Reviewer", "Writer"]);
  });

  it("breaks a tie on the identifier, so two reads of one registry agree", () => {
    // The registry holds the name unique per node, so a tie should be unreachable, but an
    // order resting on a guarantee it cannot check reshuffles under a person's cursor the day
    // the guarantee slips.
    const rows = projectDefinitionRows(
      [
        definition({ definitionId: "definition-9", name: "Same" }),
        definition({ definitionId: "definition-2", name: "Same" }),
      ],
      "en",
    );
    expect(rows.map((row) => row.definitionId)).toStrictEqual(["definition-2", "definition-9"]);
  });

  it("negative control: it does not simply hand back the order it was given", () => {
    // Otherwise both cases above would pass for a projection that returned its input untouched
    // whenever it arrived sorted.
    const rows = projectDefinitionRows(
      [
        definition({ definitionId: "definition-z", name: "Zeta" }),
        definition({ definitionId: "definition-a", name: "Alpha" }),
      ],
      "en",
    );
    expect(rows.map((row) => row.name)).toStrictEqual(["Alpha", "Zeta"]);
  });

  it("leaves the caller's array alone", () => {
    const given = [
      definition({ definitionId: "definition-z", name: "Zeta" }),
      definition({ definitionId: "definition-a", name: "Alpha" }),
    ];
    projectDefinitionRows(given, "en");
    expect(given.map((record) => record.name)).toStrictEqual(["Zeta", "Alpha"]);
  });
});

describe("the registry projection — reading the stored rows", () => {
  it("reads an empty registry as the empty reading", () => {
    expect(readDefinitions([]).kind).toBe("empty");
  });

  it("answers with rows when there are rows", () => {
    const reading = readDefinitions([definition()]);
    expect(reading.kind).toBe("rows");
    expect(reading.kind === "rows" ? reading.rows.length : 0).toBe(1);
  });
});

describe("the registry projection — what a settlement says out loud", () => {
  it("says what was read and how many", () => {
    expect(
      describeDefinitionSettlement({
        kind: "rows",
        rows: projectDefinitionRows([definition(), definition({ definitionId: "definition-2" })]),
      }),
    ).toBe("Read 2 saved sidekicks.");
  });

  it("counts one in the singular", () => {
    expect(
      describeDefinitionSettlement({ kind: "rows", rows: projectDefinitionRows([definition()]) }),
    ).toBe("Read 1 saved sidekick.");
  });

  it("says the empty registry's own sentence", () => {
    expect(describeDefinitionSettlement({ kind: "empty" })).toBe(`${NO_SAVED_DEFINITIONS}.`);
  });

  it("negative control: the two settlements do not say one thing", () => {
    // Otherwise the cases above would pass for a describer that returned a constant matching
    // one of them.
    const spoken = new Set([
      describeDefinitionSettlement({ kind: "empty" }),
      describeDefinitionSettlement({ kind: "rows", rows: projectDefinitionRows([definition()]) }),
    ]);
    expect(spoken.size).toBe(2);
  });
});

describe("the registry projection — the delete question", () => {
  it("names the record", () => {
    const [row] = projectDefinitionRows([definition({ name: "Reviewer" })]);
    expect(row).toBeDefined();
    expect(describeDeletionQuestion(row!)).toContain("Reviewer");
  });
});
