// The four positions, the two absences the projection refuses to merge, and each position's
// words. Every case guards one way of collapsing a distinction the wire draws.

import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../agents-caps.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import {
  agentEntry,
  resolvedConfiguration,
} from "./components/agent-binding-column.test-support.js";
import {
  NAMELESS_TOOL_ALLOWLIST_WORDING,
  agentToolAllowlistPosition,
  namedToolAllowlistSentence,
} from "./tool-allowlist.js";

const IDENTITY_ONLY = agentEntry();

/** A list of exactly `count` distinct tool names. */
function toolNames(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `tool-${String(index)}`);
}

describe("agent tool grant — the four positions", () => {
  it("reads an agent with no resolved configuration as unanswered", () => {
    expect(agentToolAllowlistPosition(IDENTITY_ONLY)).toStrictEqual({ kind: "not-reported" });
  });

  it("reads a configuration whose allowlist is null as the provider's default set", () => {
    expect(
      agentToolAllowlistPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: resolvedConfiguration({ toolAllowlist: null }),
      }),
    ).toStrictEqual({ kind: "driver-default" });
  });

  it("reads a present, empty allowlist as a chosen restriction", () => {
    expect(
      agentToolAllowlistPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: resolvedConfiguration({ toolAllowlist: [] }),
      }),
    ).toStrictEqual({ kind: "no-tools" });
  });

  it("carries the names of a populated allowlist, in the order the echo sent them", () => {
    // The names ride the position because the line takes the length and the echo's row takes the
    // names; a second read of the member is how they disagreed on the empty case.
    expect(
      agentToolAllowlistPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: resolvedConfiguration({
          toolAllowlist: ["read", "write", "search"],
        }),
      }),
    ).toStrictEqual({ kind: "named", toolNames: ["read", "write", "search"] });
  });

  it("negative control: the two absences resolve to different positions", () => {
    // Guards against a projection that folded an unreported configuration into driver-default.
    const unreported = agentToolAllowlistPosition(IDENTITY_ONLY);
    const driverDefault = agentToolAllowlistPosition({
      ...IDENTITY_ONLY,
      resolvedConfiguration: resolvedConfiguration({ toolAllowlist: null }),
    });
    expect(unreported.kind).not.toBe(driverDefault.kind);
  });
});

describe("agent tool grant — one position, one set of words", () => {
  it("gives the driver-default position a reading that never says 'reported'", () => {
    // The line called this state the provider's default set while the Tools row called it "not
    // reported".
    const wording = NAMELESS_TOOL_ALLOWLIST_WORDING["driver-default"];
    expect(wording.reading).not.toContain("reported");
    expect(wording.lineSentence).not.toContain("reported");
    expect(wording.weight).toBe("absent");
  });

  it("negative control: the unanswered position DOES say so, and at the same weight", () => {
    // Guards against a table that stopped distinguishing the two absences.
    const wording = NAMELESS_TOOL_ALLOWLIST_WORDING["not-reported"];
    expect(wording.reading).toContain("Not reported");
    expect(wording.lineSentence).toContain("not started from a saved definition");
    expect(wording.reading).not.toBe(NAMELESS_TOOL_ALLOWLIST_WORDING["driver-default"].reading);
  });

  it("weights a chosen empty allowlist as a decision rather than an absence", () => {
    expect(NAMELESS_TOOL_ALLOWLIST_WORDING["no-tools"].weight).toBe("derived");
  });

  it("says the short reading and the long sentence are not the same words", () => {
    // The disclosure repeats nothing the line said: it names the tools, or states the position
    // in the fewest true words where there are none.
    for (const wording of Object.values(NAMELESS_TOOL_ALLOWLIST_WORDING)) {
      expect(wording.reading.length).toBeLessThan(wording.lineSentence.length);
    }
  });
});

describe("agent tool grant — a populated allowlist is never promised whole", () => {
  it('names one tool as one tool, never as "1 tools"', () => {
    expect(namedToolAllowlistSentence(toolNames(1))).toContain(
      "the one tool, named in the resolved",
    );
    expect(namedToolAllowlistSentence(toolNames(1))).not.toContain("1 tools");
  });

  it("promises the whole list at the cap, where the echo does name every one", () => {
    const sentence = namedToolAllowlistSentence(toolNames(TOOL_ALLOWLIST_NAMED_CAP));
    expect(sentence).toContain(`${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} tools`);
    expect(sentence).toContain("named in the resolved configuration below");
    expect(sentence).not.toContain("the first");
  });

  it("promises only the first cap-many one tool past it", () => {
    // The echo names `TOOL_ALLOWLIST_NAMED_CAP` and folds the rest, so "named below" for a
    // longer list describes names not shown. One past the cap is where the spellings part.
    const sentence = namedToolAllowlistSentence(toolNames(TOOL_ALLOWLIST_NAMED_CAP + 1));
    expect(sentence).toContain(`${formatCount(TOOL_ALLOWLIST_NAMED_CAP + 1)} tools`);
    expect(sentence).toContain(
      `the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named in the resolved configuration below`,
    );
  });

  it("says the same of a list far past the cap, with the whole count still stated", () => {
    const sentence = namedToolAllowlistSentence(toolNames(15));
    expect(sentence).toContain(`${formatCount(15)} tools`);
    expect(sentence).toContain(`the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named`);
  });

  it("negative control: past the cap it makes no unqualified promise at all", () => {
    // Guards against a sentence that says both the qualified and unqualified clause.
    const sentence = namedToolAllowlistSentence(toolNames(TOOL_ALLOWLIST_NAMED_CAP + 1));
    expect(sentence).not.toContain("tools, named in the resolved");
  });
});
