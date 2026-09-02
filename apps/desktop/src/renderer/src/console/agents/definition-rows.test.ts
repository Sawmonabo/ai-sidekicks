// The registry projection: what a row says, in what order, and what it refuses to
// turn an absence into.
//
// The properties worth the most are the ones a screen cannot show you are missing.
// A row that silently dropped an axis would look complete; a list whose order came
// out of the daemon's iteration would look sorted until two reads disagreed; and an
// allowlist of `null` rendered as "no tools" would state the opposite of the truth
// in words that read fine. Each of those is asserted here against the real
// projection, with a negative control that fails on the shape it would otherwise
// pass over.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../bridge/index.js";
import {
  NO_SAVED_SIDEKICKS,
  describeDefinitionSettlement,
  describeDeletionQuestion,
  projectDefinitionRows,
  readDefinitionOutcome,
  type SidekickDefinitionRecord,
} from "./definition-rows.js";

/**
 * One stored record, every axis pinned.
 *
 * Written out in full rather than built from partials, so the count assertions
 * below measure the real shape: a helper that defaulted a member would hide exactly
 * the axis a projection had forgotten.
 */
function definition(overrides: Partial<SidekickDefinitionRecord> = {}): SidekickDefinitionRecord {
  return {
    definitionId: "definition-1",
    name: "Reviewer",
    description: "Reads a diff and says what it would change.",
    driverName: "claude",
    modelId: "claude-opus-4-6",
    providerAccountId: "account-work",
    effort: "high",
    executionPostureMode: "workspace-sandboxed",
    instructions: "Be exact.",
    goal: "Ship a clean diff.",
    toolAllowlist: ["read", "grep"],
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-02T11:30:00.000Z",
    ...overrides,
  };
}

/** The three members the row header carries, so the axis count is derived and not guessed. */
const HEADER_MEMBERS = ["definitionId", "name", "description"] as const;

describe("the registry projection — what a row carries", () => {
  it("gives every member of the record a home, and invents none", () => {
    // The claim is a COUNT against the record itself rather than a list written
    // here: an axis list restated in a test drifts from the shape the same way a
    // second declaration of the shape would.
    const record = definition();
    const [row] = projectDefinitionRows([record]);
    expect(row).toBeDefined();
    expect(row?.axes).toHaveLength(Object.keys(record).length - HEADER_MEMBERS.length);
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
    // `null` is the materialised inherit state, and the sentence that explains it is
    // ours — rendering it as a wire figure would attribute our words to the daemon.
    const [row] = projectDefinitionRows([
      definition({ providerAccountId: null, effort: null, executionPostureMode: null }),
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
    // Without this, the case above would pass over a projection that ignored the
    // value and always said "default".
    const [row] = projectDefinitionRows([definition({ effort: "low" })]);
    const effort = row?.axes.find((axis) => axis.key === "effort");
    expect(effort?.reading).toBe("low");
    expect(effort?.source).toBe("wire");
  });

  it("keeps the allowlist's three states three", () => {
    // `null` is the driver's defaults and `[]` is no tools at all. They read alike
    // and mean opposite things, which is why the stored shape keeps them apart.
    const readingFor = (allowlist: readonly string[] | null): string | undefined =>
      projectDefinitionRows([definition({ toolAllowlist: allowlist })])[0]?.axes.find(
        (axis) => axis.key === "tools",
      )?.reading;
    expect(readingFor(null)).toBe("The driver's defaults");
    expect(readingFor([])).toBe("No tools");
    expect(readingFor(["read"])).toBe("1 tool");
    expect(readingFor(["read", "grep", "glob"])).toBe("3 tools");
  });

  it("reports whether there is prose, and never the prose itself", () => {
    // The text belongs to the editor. A clamped passage in a list row would be a
    // third rendering of a body that already has two homes.
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
    // A saved record's instants span days, and the console's ledger clock format
    // drops the date because a ledger has a day divider. This list has none, so a
    // formatted reading would be wrong rather than merely terse.
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
    // The registry holds the name unique per node, so a tie should be unreachable —
    // but an order resting on a guarantee it cannot check stops being stable the day
    // the guarantee slips, and an unstable list reshuffles under a person's cursor.
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
    // Without this, both cases above would pass over a projection that returned its
    // input untouched whenever the input happened to arrive sorted.
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

describe("the registry projection — reading one outcome", () => {
  it("keeps a refusal a refusal rather than an empty registry", () => {
    const reading = readDefinitionOutcome(growthUnavailable("sidekickDefinitionList"));
    expect(reading.kind).toBe("refused");
    expect(reading.kind === "refused" ? reading.refusal.code : "").toBe("wire-unregistered");
  });

  it("negative control: a served empty registry IS the empty reading", () => {
    // Without this, the case above would pass over a reader that answered "refused"
    // for everything, which conflates the two absences in the other direction.
    expect(readDefinitionOutcome({ status: "served", value: [] }).kind).toBe("empty");
  });

  it("answers with rows when there are rows", () => {
    const reading = readDefinitionOutcome({ status: "served", value: [definition()] });
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
    expect(describeDefinitionSettlement({ kind: "empty" })).toBe(`${NO_SAVED_SIDEKICKS}.`);
  });

  it("speaks the refusal's sentence and not its code", () => {
    // Read aloud, a code is a token nobody can act on, ahead of the sentence that
    // matters. It stays on the screen, in mono, where it can be copied.
    const refusal = growthUnavailable("sidekickDefinitionList");
    const spoken = describeDefinitionSettlement({ kind: "refused", refusal });
    expect(spoken).toBe(refusal.detail);
    expect(spoken).not.toContain(refusal.code);
  });

  it("negative control: the three settlements do not all say one thing", () => {
    // Without this, the cases above would pass over a describer that returned a
    // constant that happened to match one of them.
    const spoken = new Set([
      describeDefinitionSettlement({ kind: "empty" }),
      describeDefinitionSettlement({ kind: "rows", rows: projectDefinitionRows([definition()]) }),
      describeDefinitionSettlement({
        kind: "refused",
        refusal: growthUnavailable("sidekickDefinitionList"),
      }),
    ]);
    expect(spoken.size).toBe(3);
  });
});

describe("the registry projection — the delete question", () => {
  it("names the record and states what deleting it does not reach", () => {
    const [row] = projectDefinitionRows([definition({ name: "Reviewer" })]);
    expect(row).toBeDefined();
    const question = describeDeletionQuestion(row!);
    expect(question).toContain("Reviewer");
    expect(question).toContain("keeps the configuration it was given");
  });

  it("negative control: it does not ask a bare are-you-sure", () => {
    // Without this, the case above would pass over a question that named the record
    // and left a person weighing a consequence the registry does not have.
    const [row] = projectDefinitionRows([definition()]);
    expect(row).toBeDefined();
    expect(describeDeletionQuestion(row!).length).toBeGreaterThan(40);
  });
});
