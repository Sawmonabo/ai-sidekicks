// Every form the console's syntax bans mean to refuse, planted and measured.
//
// WHY THIS FILE EXISTS. `apps/desktop/eslint.config.mjs` bans the lenient date readings
// and the lexical ordering of two stamps, and each ban is an esquery selector — a claim
// about tree SHAPE, which is exactly the kind of claim that is right about the spelling
// its author had in mind and silent about the four beside it. Three of these selectors
// were measured missing the one call site they were written for: a nullish-defaulted
// stamp is a logical expression and not a member, `new Date(iso)` carries no `…At` in
// its name, and `Date.parse` reached by a destructure writes neither name beside the
// other. Each hole read exactly like compliance.
//
// So the rows below are the ban's own subject list, driven through the REAL engine over
// the REAL config. Both directions are planted: what must be refused, and what must
// stay legitimate — a ban whose false alarms outnumber its findings is a ban somebody
// turns off, and the second table is what keeps that from happening quietly.
//
// The engine and the probe path come from `test/console/eslint-harness.ts`, so a claim
// here runs against the same config resolution the exemption census resolves its set
// from. Nothing in this file restates a selector: a copy would pass with the config
// deleted, which is the failure it exists to prevent.

import { describe, expect, it } from "vitest";

import {
  createDesktopLinter,
  ESLINT_CASE_BUDGET_MS,
  NON_EXEMPT_CONSOLE_PROBE_PATH,
  ruleMessagesAt,
} from "../eslint-harness.js";

const AUDITED_RULE = "no-restricted-syntax";

/** One planted row: source the ban must refuse, or source it must leave alone. */
interface SyntaxBanCase {
  readonly source: string;
  /** What a reader learns from the row, and what the failure message names. */
  readonly reading: string;
}

/**
 * The stamp-ordering rows, every one of them measured against the selectors this table
 * drove out.
 *
 * Rows 2 and 3 are the shapes that passed: the composer's rows carry `touchedAt` as
 * `string | undefined`, so a comparator writes the nullish default, and `String(...)`
 * around a stamp is what a caller writes when the type will not narrow. Row 4 is the
 * shorter spelling of the same defect, which `core/instant.ts` names in the same breath
 * as `localeCompare` and which no selector banned at all.
 */
const REFUSED_STAMP_ORDERINGS: readonly SyntaxBanCase[] = [
  {
    source: "export const order = right.touchedAt.localeCompare(left.touchedAt);",
    reading: "the plain member form",
  },
  {
    source: 'export const order = (right.touchedAt ?? "").localeCompare(left.touchedAt ?? "");',
    reading: "a nullish-defaulted stamp, which is a logical expression and not a member",
  },
  {
    source: "export const order = String(right.touchedAt).localeCompare(String(left.touchedAt));",
    reading: "a stamp behind `String(...)`, which is a call and not a member",
  },
  {
    source: "export const order = left.createdAt < right.createdAt ? -1 : 1;",
    reading: "`<` on two stamps, the spelling a comparator reaches for first",
  },
  {
    source: "export const isLater = startedAt > endedAt;",
    reading: "`>` on two bare stamp names",
  },
  {
    source: 'export const order = (left.createdAt ?? "") < (right.createdAt ?? "");',
    reading: "a defaulted stamp inside a comparison",
  },
];

/**
 * What the same two rules must NOT refuse.
 *
 * The last two are the reason the comparison arm keys on BOTH operands: this tree
 * carries two `…At` figures that are numbers — `dueAt` on the frozen clock's entries and
 * `updatedAt` on a persistence record — and each is compared against a plain identifier.
 */
const ADMITTED_STAMP_ORDERINGS: readonly SyntaxBanCase[] = [
  {
    source: "export const order = left.displayPath.localeCompare(right.displayPath);",
    reading: "ordering a path, which is what `localeCompare` is for",
  },
  {
    source: "export const rows = all.filter((row) => row.createdAt).length > 0;",
    reading: "a comparison that merely contains a stamp somewhere inside it",
  },
  { source: "export const due = entry.dueAt <= target;", reading: "the clock's numeric due time" },
  {
    source: "export const oldest = entry.updatedAt < oldestUpdatedAt;",
    reading: "a persistence record's numeric write stamp",
  },
];

/**
 * The `new Date` rows. Rows 3 and 4 are what refuted the name-keyed heuristic: the
 * console's own figure chokepoint takes a wire stamp as `formatClockTime(iso: string)`.
 */
const REFUSED_DATE_READINGS: readonly SyntaxBanCase[] = [
  { source: "export const at = new Date(row.createdAt);", reading: "a member named for a stamp" },
  { source: "export const at = new Date(createdAt);", reading: "a bare name for a stamp" },
  { source: "export const at = new Date(iso);", reading: "the lower-case name the corpus writes" },
  { source: "export const at = new Date(stamp);", reading: "a name that says nothing at all" },
  { source: "export const at = Date.parse(iso);", reading: "the call the ban was written for" },
  { source: "export const { parse } = Date;", reading: "the function taken by a destructure" },
  {
    source: 'export const at = Date["parse"](iso);',
    reading: "the function taken by a computed key",
  },
  {
    source: "export const at = globalThis.Date.parse(iso);",
    reading: "the function read through the global object",
  },
];

/** What the same rules must leave open: every numeric construction the tree writes. */
const ADMITTED_DATE_READINGS: readonly SyntaxBanCase[] = [
  { source: "export const at = new Date(sequence);", reading: "a fixture counter" },
  { source: "export const at = new Date(startedAtMilliseconds);", reading: "a named number" },
  { source: "export const at = new Date(Date.UTC(2026, 0, 1));", reading: "a composed instant" },
  { source: "export const at = new Date(base + offsetMs);", reading: "a sum, which is not a name" },
  { source: "export const at = new Date(0);", reading: "a numeric literal" },
  {
    source: "export const now = Date.now();",
    reading: "the one time reading `core/clock.ts` uses",
  },
];

describe("console syntax bans — every planted row lands on the side it belongs", () => {
  const linter = createDesktopLinter();

  async function refusals(source: string): Promise<readonly string[]> {
    return ruleMessagesAt(linter, source, NON_EXEMPT_CONSOLE_PROBE_PATH, AUDITED_RULE);
  }

  for (const { source, reading } of [...REFUSED_STAMP_ORDERINGS, ...REFUSED_DATE_READINGS]) {
    it(
      `refuses ${reading}`,
      async () => {
        expect(await refusals(source), source).not.toStrictEqual([]);
      },
      ESLINT_CASE_BUDGET_MS,
    );
  }

  for (const { source, reading } of [...ADMITTED_STAMP_ORDERINGS, ...ADMITTED_DATE_READINGS]) {
    it(
      `admits ${reading}`,
      async () => {
        expect(await refusals(source), source).toStrictEqual([]);
      },
      ESLINT_CASE_BUDGET_MS,
    );
  }

  it(
    "negative control: the probe path is covered, so an admitted row is not an unlinted one",
    async () => {
      // Every "admits" row above is an empty message list, and so is every row linted at
      // a path the ban block does not match. Without this the second table would pass
      // with the block deleted.
      expect(await refusals("export const at = Date.parse(iso);\n")).not.toStrictEqual([]);
    },
    ESLINT_CASE_BUDGET_MS,
  );
});
