// The four positions, the two absences the projection refuses to merge, and the
// words each position gets.
//
// Every case here is one way of collapsing a distinction the wire draws: a reply
// that said nothing about tools read as "the driver's default set", a chosen empty
// list read as an absence, or a capped echo promised whole.

import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../../core/index.js";
import { formatCount } from "../../primitives/index.js";
import type { AgentRosterEntry } from "../../bridge/index.js";
import {
  NAMELESS_TOOL_GRANT_WORDING,
  agentToolGrantPosition,
  namedToolGrantSentence,
} from "./tool-grant.js";

const IDENTITY_ONLY: AgentRosterEntry = { agentId: "agent-scout", state: "ready" };

/** A list of exactly `count` distinct tool names, which is all these cases need. */
function toolNames(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `tool-${String(index)}`);
}

describe("agent tool grant — the four positions", () => {
  it("reads a reply with no resolved configuration as unanswered", () => {
    expect(agentToolGrantPosition(IDENTITY_ONLY)).toStrictEqual({ kind: "not-reported" });
  });

  it("reads a configuration with no allowlist member as the driver's default set", () => {
    expect(
      agentToolGrantPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: { executionPostureMode: "worktree" },
      }),
    ).toStrictEqual({ kind: "driver-default" });
  });

  it("reads a present, empty allowlist as a chosen restriction", () => {
    expect(
      agentToolGrantPosition({ ...IDENTITY_ONLY, resolvedConfiguration: { toolAllowlist: [] } }),
    ).toStrictEqual({ kind: "no-tools" });
  });

  it("carries the names of a populated allowlist, in the order the echo sent them", () => {
    // The names ride the position because BOTH surfaces that state this grant read
    // it — the line takes the length, the echo's row takes the names — and a second
    // read of the member is how the two came to disagree about the empty case.
    expect(
      agentToolGrantPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: { toolAllowlist: ["read", "write", "search"] },
      }),
    ).toStrictEqual({ kind: "named", toolNames: ["read", "write", "search"] });
  });

  it("negative control: the two absences resolve to different positions", () => {
    // Without this, a projection that folded an unreported configuration into the
    // driver-default arm would pass both of the cases above that assert one each.
    const unreported = agentToolGrantPosition(IDENTITY_ONLY);
    const driverDefault = agentToolGrantPosition({
      ...IDENTITY_ONLY,
      resolvedConfiguration: {},
    });
    expect(unreported.kind).not.toBe(driverDefault.kind);
  });
});

describe("agent tool grant — one position, one set of words", () => {
  it("gives the driver-default position a reading that never says 'reported'", () => {
    // The defect this table closes: the line called this state the driver's default
    // set while the echo's Tools row, reading the member for itself, called the same
    // state "not reported" three lines below it.
    const wording = NAMELESS_TOOL_GRANT_WORDING["driver-default"];
    expect(wording.reading).not.toContain("reported");
    expect(wording.lineSentence).not.toContain("reported");
    expect(wording.weight).toBe("absent");
  });

  it("negative control: the unanswered position DOES say so, and at the same weight", () => {
    // Without this the case above would pass over a table that had stopped
    // distinguishing the two absences at all, which is the conflation in reverse.
    const wording = NAMELESS_TOOL_GRANT_WORDING["not-reported"];
    expect(wording.reading).toContain("Not reported");
    expect(wording.lineSentence).toContain("was not answered");
    expect(wording.reading).not.toBe(NAMELESS_TOOL_GRANT_WORDING["driver-default"].reading);
  });

  it("weights a chosen empty allowlist as a decision rather than an absence", () => {
    expect(NAMELESS_TOOL_GRANT_WORDING["no-tools"].weight).toBe("derived");
  });

  it("says the short reading and the long sentence are not the same words", () => {
    // The disclosure repeats nothing the line already said: it names the tools, and
    // states the position in the fewest words that are true where there are none.
    for (const wording of Object.values(NAMELESS_TOOL_GRANT_WORDING)) {
      expect(wording.reading.length).toBeLessThan(wording.lineSentence.length);
    }
  });
});

describe("agent tool grant — a populated allowlist is never promised whole", () => {
  it('names one tool as one tool, never as "1 tools"', () => {
    expect(namedToolGrantSentence(toolNames(1))).toContain("the one tool it was attached with");
    expect(namedToolGrantSentence(toolNames(1))).not.toContain("1 tools");
  });

  it("promises the whole list at the cap, where the echo does name every one", () => {
    const sentence = namedToolGrantSentence(toolNames(TOOL_ALLOWLIST_NAMED_CAP));
    expect(sentence).toContain(`${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} tools`);
    expect(sentence).toContain("named in the resolved configuration below");
    expect(sentence).not.toContain("the first");
  });

  it("promises only the first cap-many one tool past it", () => {
    // The echo names `TOOL_ALLOWLIST_NAMED_CAP` and folds the rest to a figure, so a
    // line saying every one of them is "named below" describes a surface that is not
    // there. One past the cap is where the two spellings part company.
    const sentence = namedToolGrantSentence(toolNames(TOOL_ALLOWLIST_NAMED_CAP + 1));
    expect(sentence).toContain(`${formatCount(TOOL_ALLOWLIST_NAMED_CAP + 1)} tools`);
    expect(sentence).toContain(
      `the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named in the resolved configuration below`,
    );
  });

  it("says the same of a list far past the cap, with the whole count still stated", () => {
    const sentence = namedToolGrantSentence(toolNames(15));
    expect(sentence).toContain(`${formatCount(15)} tools`);
    expect(sentence).toContain(`the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named`);
  });

  it("negative control: past the cap it makes no unqualified promise at all", () => {
    // Without this the two cases above would pass over a sentence that said BOTH —
    // the qualified clause appended to the unqualified one — which promises the whole
    // list in the same breath as promising the first six of it.
    const sentence = namedToolGrantSentence(toolNames(TOOL_ALLOWLIST_NAMED_CAP + 1));
    expect(sentence).not.toContain("tools it was attached with, named in the resolved");
  });
});
