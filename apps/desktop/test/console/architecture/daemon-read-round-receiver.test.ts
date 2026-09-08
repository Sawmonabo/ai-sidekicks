// What a round was OPENED OFF, driven against sources whose verdict is known.
//
// THE READING'S OWN BENCH, beside the value reading's next door and on the same
// pattern `daemon-signal-argument.test.ts` states: `read-signal-chokepoint.test.ts`
// makes the claim over the real console, and a clean result there is worth nothing
// until the receiver resolution is proved to bite. Every source here is one the
// console does not contain — the offending shapes included, which is why they cannot
// be written into the gate itself.
//
// ITS SUBJECT IS THE RECEIVER AND NOT THE VALUE. The bench next door asks what a call
// handed the door; this one starts from a call that hands a round's signal and asks
// what the ROUND came off. Both are read through one door — a site's
// `signalArgument` — because the receiver has no verdict of its own: a round opened
// off nothing this parse can see is a signal the call has not SHOWN, which is
// `"unrecognised"` for the same reason a minted controller is.

import { describe, expect, it } from "vitest";

import { plantedSites } from "./daemon-call-planting.test-support.js";

describe("what a round was opened off", () => {
  it("takes a round opened off each read scope the console declares", () => {
    // THE WHOLE ACCEPTED SET, which is the three shapes `store/read-cancellation.ts`
    // is consumed through. A class-held read line opens its round off the field it
    // MINTS the scope on; a holder that keeps its scope in a nullable field mints into
    // a local first, so the round is opened off a name the checker has already
    // narrowed — and the assignment that puts it on the field is a write this scan
    // does not follow, which is why the second shape is read as the scope it is rather
    // than refused for being local; a render-addressed line takes its scope off the
    // store's own door. A form none of the three plants is one the reading refuses.
    const [offOwnField] = plantedSites([
      "class QuotaReadout {",
      "  readonly #readLine = new ReadScope();",
      "  async seed(bridge) {",
      "    const round = this.#readLine.openRound();",
      '    return await callDaemon(bridge, "providerAccount.list", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    expect(offOwnField?.signalArgument).toBe("present");
    const [offMintedLocal] = plantedSites([
      "class CommandHolder {",
      "  #readLine = undefined;",
      "  open(bridge) {",
      "    const readLine = new ReadScope();",
      "    this.#readLine = readLine;",
      "    const round = readLine.openRound();",
      '    return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    expect(offMintedLocal?.signalArgument).toBe("present");
    const [offScopeDoor] = plantedSites([
      'import { useReadScope } from "../../store/index.js";',
      "export function readBoundary(bridge) {",
      '  const readScope = useReadScope(bridge, "roots");',
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(offScopeDoor?.signalArgument).toBe("present");
  });

  it("negative control: a round opened off anything but a read scope is not a round", () => {
    // THE HOLE THE FACTORY NAME LEFT, which is the `signal` member's hole one node
    // deeper: any property-access call named `openRound` was a round, so a helper of
    // that name answering `{ signal: <a signal nothing abandons> }` read `"present"` and
    // an unstoppable read passed the gate. Three shapes fit through it and each is a
    // different half of the rule — a name bound to no scope this parse can see, a field
    // of the reading class that holds something else, and a scope the caller handed in,
    // which is a provenance the console does not write and this reading does not guess.
    const [stranger] = plantedSites([
      "export function readBoundary(bridge, helper) {",
      "  const round = helper.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    const [strangerField] = plantedSites([
      "class QuotaReadout {",
      "  readonly #readLine = new PollingHelper();",
      "  async seed(bridge) {",
      "    const round = this.#readLine.openRound();",
      '    return await callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    const [handedScope] = plantedSites([
      "export function readBoundary(bridge, readScope: ReadScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(
      [stranger, strangerField, handedScope].map((site) => site?.signalArgument),
    ).toStrictEqual(["unrecognised", "unrecognised", "unrecognised"]);
  });

  it("negative control: an inner class does not inherit an outer field's reading", () => {
    // The field set is the CLASS's and never the module's. A private name is reachable
    // from nowhere but the class that declares it, so an inner class writing `#readLine`
    // over its own helper is a different field of the same spelling — and a module-wide
    // set would have read this line off the outer class's scope, which this one cannot
    // see at all.
    const [shadowed] = plantedSites([
      "class QuotaReadout {",
      "  readonly #readLine = new ReadScope();",
      "  hold() {",
      "    return class InnerReadout {",
      "      readonly #readLine = new PollingHelper();",
      "      async seed(bridge) {",
      "        const round = this.#readLine.openRound();",
      '        return await callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "      }",
      "    };",
      "  }",
      "}",
    ]);
    expect(shadowed?.signalArgument).toBe("unrecognised");
  });
});
