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

/**
 * The store's read-scope class, as a module that mints one imports it.
 *
 * PART OF THE READING AND NOT SCAFFOLDING AROUND IT, on the sibling bench's own reason
 * for planting the door clause: a scope is the store's export or it is nothing, so a
 * case writing `new ReadScope()` under no clause at all would report the factory's
 * refusal under the name of whatever that case meant to be about.
 */
const READ_SCOPE_CLASS_IMPORT = 'import { ReadScope } from "../store/index.js";';

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
      READ_SCOPE_CLASS_IMPORT,
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
      READ_SCOPE_CLASS_IMPORT,
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
      'import { useReadScope } from "../store/index.js";',
      "export function readBoundary(bridge) {",
      '  const readScope = useReadScope(bridge, "roots");',
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(offScopeDoor?.signalArgument).toBe("present");
  });

  it("takes a scope imported from the module that declares it, not only the door", () => {
    // THE STORE HAS TWO HOMES AND BOTH ARE ADMITTED. `store/read-cancellation.ts`
    // declares the two exports and `store/index.ts` re-exports them, and which one a
    // consumer writes is a question about where it sits: the two modules inside `store/`
    // import the declaring module directly — a family door reached from inside its own
    // family is the barrel chain the package forbids — while the six outside it go
    // through the door. A reading that admitted only the barrel would report the
    // scheduler's own read line as a round nothing aborts.
    const [offDeclaringModule] = plantedSites([
      'import { ReadScope } from "../store/read/read-cancellation.js";',
      "class RefreshScheduler {",
      "  readonly #readLine = new ReadScope();",
      "  async seed(bridge) {",
      "    const round = this.#readLine.openRound();",
      '    return await callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    expect(offDeclaringModule?.signalArgument).toBe("present");
  });

  it("negative control: the store's names imported from another module are not the store's", () => {
    // THE HOLE THE NAME-ONLY IDENTITY LEFT, and it is the module half of the pair an
    // export is. Both names resolved to an import specifier and the specifier's own
    // MODULE was never asked, so a module publishing its own `ReadScope` and
    // `useReadScope` from anywhere in the tree was read as the store's — a scope this
    // parse never saw declared, opened into a round nothing aborts, at all three of the
    // positions the reading admits: a class's own field, a `const` that mints one, and a
    // `const` bound to the door.
    const strangerModule = 'import { ReadScope, useReadScope } from "./helpers.js";';
    const [strangerField] = plantedSites([
      strangerModule,
      "class QuotaReadout {",
      "  readonly #readLine = new ReadScope();",
      "  async seed(bridge) {",
      "    const round = this.#readLine.openRound();",
      '    return await callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    const [strangerMint] = plantedSites([
      strangerModule,
      "export function readBoundary(bridge) {",
      "  const readLine = new ReadScope();",
      "  const round = readLine.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    const [strangerDoor] = plantedSites([
      strangerModule,
      "export function readBoundary(bridge) {",
      '  const readScope = useReadScope(bridge, "roots");',
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(
      [strangerField, strangerMint, strangerDoor].map((site) => site?.signalArgument),
    ).toStrictEqual(["unrecognised", "unrecognised", "unrecognised"]);
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

  it("negative control: a factory this module never imported is not the store's", () => {
    // THE HOLE A FACTORY NAME LEFT ONE NODE FURTHER OUT. The round's receiver was
    // resolved and the receiver's own factory was not, so any member named
    // `useReadScope` opened a read scope: `helper.useReadScope()` on a parameter
    // answered a scope this parse never saw declared, and the round opened off it
    // carried a signal nothing aborts. `new ReadScope()` had the same hole, read as
    // the store's class on the strength of the spelling alone. The three shapes are
    // the three provenances a name can have that are not the store's own export — a
    // member of something handed in, a call this module never imported, and a class of
    // that spelling declared right here.
    const [strangerFactory] = plantedSites([
      "export function readBoundary(bridge, helper) {",
      "  const readScope = helper.useReadScope();",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    const [unimportedDoor] = plantedSites([
      "export function readBoundary(bridge) {",
      '  const readScope = useReadScope(bridge, "roots");',
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    const [locallyDeclaredClass] = plantedSites([
      "class ReadScope {",
      "  openRound() {",
      "    return { signal: new AbortController().signal };",
      "  }",
      "}",
      "export function readBoundary(bridge) {",
      "  const readLine = new ReadScope();",
      "  const round = readLine.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(
      [strangerFactory, unimportedDoor, locallyDeclaredClass].map((site) => site?.signalArgument),
    ).toStrictEqual(["unrecognised", "unrecognised", "unrecognised"]);
  });

  it("negative control: an inner class does not inherit an outer field's reading", () => {
    // The field set is the CLASS's and never the module's. A private name is reachable
    // from nowhere but the class that declares it, so an inner class writing `#readLine`
    // over its own helper is a different field of the same spelling — and a module-wide
    // set would have read this line off the outer class's scope, which this one cannot
    // see at all.
    const [shadowed] = plantedSites([
      READ_SCOPE_CLASS_IMPORT,
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
