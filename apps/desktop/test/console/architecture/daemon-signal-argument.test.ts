// What a door call HANDED the door, driven against sources whose verdict is known.
//
// THE GATE IS TWO DOORS DOWN AND THIS IS THE READING'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-signal-chokepoint.test.ts` makes the claim
// over the real console, and a clean result there is worth nothing until the reading
// is proved to bite. Every case below writes a source the console does not contain —
// the offending shapes included, which is why they cannot be written in the gate
// itself.
//
// ITS SUBJECT IS THE VALUE AND NOT THE CALL. `daemon-call-sites.test.ts` pins which
// calls reach the door and `daemon-method-resolution.test.ts` what each of them names;
// this one starts from a call that does and asks what its options argument SHOWS about
// the thing that stops it, which is the reading both of the census's rules are written
// against. The two benches and `daemon-read-signal-census.test.ts` share one planted
// corpus so none of them drifts from the others.

import { describe, expect, it } from "vitest";

import { plantedSites, plantedSitesInReadHelper } from "./daemon-call-planting.test-support.js";

describe("the signal a call hands the door", () => {
  it("reports an options argument it cannot read as its own answer", () => {
    // A spread and a held variable each hide the member from this parse. Answering
    // `absent` for them was fail-closed for a read and fail-OPEN for a record, whose
    // rule is that no signal was passed — so the reading is not a boolean.
    const [spread] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { ...options });',
    ]);
    expect(spread?.signalArgument).toBe("opaque");
    const [held] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, options);',
    ]);
    expect(held?.signalArgument).toBe("opaque");
    const [read] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "session.join", request, { cause });',
    ]);
    expect(read?.signalArgument).toBe("absent");
  });

  it("takes a forwarded parameter, annotated or contextually typed", () => {
    // The two spellings the console's own reads carry: the `repos` and inventory
    // helpers annotate `signal: AbortSignal`, and the arrow a push-driven read hands
    // its round's signal to declares nothing, because the seat's option type declares
    // it. Both are signals this call was HANDED, which is the property that matters.
    const [annotated] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal });',
    ]);
    expect(annotated?.signalArgument).toBe("present");
    const [contextual] = plantedSites([
      "export function createRoster(bridge) {",
      "  return new PushDrivenRead({",
      "    read: async (signal) =>",
      '      await callDaemon(bridge, "repo.workspaceList", {}, { signal }),',
      "  });",
      "}",
    ]);
    expect(contextual?.signalArgument).toBe("present");
  });

  it("negative control: a parameter the caller may omit is not a forwarded signal", () => {
    // THE HOLE PARAMETERHOOD LEFT. `signal = new AbortController().signal` reached the
    // accepting arm on the strength of having no declared type — and it is the exact
    // shape the rule exists to refuse: every caller may leave it out, the default is a
    // controller this scope minted, and no read scope ever aborts it, so the call looks
    // stoppable and the read cannot be stopped. The annotated spelling is the same
    // defect wearing the type the arm was checking for, and `signal?: AbortSignal` is
    // the same permission to omit written with one token instead of an expression —
    // whose omission hands the door `undefined`, which stops even less. The rest is
    // written unannotated on purpose: an `AbortSignal[]` annotation is refused by the
    // type test alone, so it would prove nothing about the conjunct it is here for.
    const selfDefaulted = plantedSites([
      "export async function performRead(bridge, request, signal = new AbortController().signal) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    const annotatedDefault = plantedSites([
      "export async function performRead(",
      "  bridge,",
      "  request,",
      "  signal: AbortSignal = new AbortController().signal,",
      ") {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    const optional = plantedSites([
      "export async function performRead(bridge, request, signal?: AbortSignal) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    const rest = plantedSites([
      "export async function performRead(bridge, request, ...signal) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    expect(
      [selfDefaulted, annotatedDefault, optional, rest].map(
        ([site]) => site?.signalArgument ?? "no site",
      ),
    ).toStrictEqual(["unrecognised", "unrecognised", "unrecognised", "unrecognised"]);
  });

  it("negative control: a round the caller may omit is not a held round either", () => {
    // The same rule at the other parameter arm, which the annotation alone used to
    // admit. A default this scope supplies is a round nothing outside the call
    // supersedes, and the line has shown no more about what stops it than a defaulted
    // signal does.
    const [defaultedRound] = plantedSites([
      "async function performRead(bridge, request, round: ReadRound = openSomeRound()) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal: round.signal });',
      "}",
    ]);
    expect(defaultedRound?.signalArgument).toBe("unrecognised");
  });

  it("takes a round's signal, off the parameter and off the local it was opened into", () => {
    // The other two shapes `store/read-cancellation.ts` produces. A performer is
    // handed the round; a reader that owns the line opens one on its own scope.
    const [handed] = plantedSites([
      "class QuotaReadout {",
      "  async #read(round: ReadRound) {",
      '    return await callDaemon(this.#bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    expect(handed?.signalArgument).toBe("present");
    const [opened] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(opened?.signalArgument).toBe("present");
    // THE SAME MEMBER, KEYED RATHER THAN DOTTED. `round["signal"]` reads the member
    // `round.signal` reads, off the binding `round.signal` reads it off, so this reading
    // takes `daemon-call-census.ts`' shared member predicate rather than the dotted copy
    // it carried — which had the two spellings of one rule disagreeing one module over
    // from where the rule is stated.
    const [keyed] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round["signal"] });',
      "}",
    ]);
    expect(keyed?.signalArgument).toBe("present");
  });

  it("negative control: a type wrapper around the round is not a different round", () => {
    // THE PEEL THE OBJECT SIDE WAS MISSING. The value handed as `signal` went through
    // the shared peeler and the member read's own OBJECT went through a bare identifier
    // test, so `(round as ReadRound).signal` — the accepted round, its accepted member,
    // its accepted binding — answered `"unrecognised"` because a type assertion sat
    // between the name and the dot. A wrapper is a claim about a type and this reading
    // is about a binding, so it can never be the difference between the two verdicts.
    const [asserted] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: (round as ReadRound).signal });',
      "}",
    ]);
    expect(asserted?.signalArgument).toBe("present");
    const [parenthesized] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: (round).signal });',
      "}",
    ]);
    expect(parenthesized?.signalArgument).toBe("present");
    // And the peel is a peel rather than a rule that admits everything: a wrapper around
    // something that is not a held round is still not one.
    const [wrappedStranger] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: (ambient as ReadRound).signal });',
      "}",
    ]);
    expect(wrappedStranger?.signalArgument).toBe("unrecognised");
  });

  it("negative control: a key this parse cannot resolve is not the round's signal", () => {
    // The other side of that predicate, and the depth limit rather than an exception to
    // it: `round[member]` requires deciding what `member` holds, which is a value this
    // scan does not follow. The call has therefore SHOWN no signal, and the read rule
    // refuses it exactly as it refuses one the call minted itself.
    const [computed] = plantedSites([
      "export function readBoundary(bridge, readScope, member) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round[member] });',
      "}",
    ]);
    expect(computed?.signalArgument).toBe("unrecognised");
  });

  it("negative control: a signal this call minted itself is not the round's", () => {
    // THE HOLE A KEY CHECK LEAVES, in the four spellings that fit through it. Each
    // line hands the door a member NAMED `signal` and none of them is a signal the
    // read line can abort: an already-aborted one stops nothing that ever ran, and a
    // controller minted beside the call is superseded by nothing and abandoned by
    // nobody. All four answered `"present"` while the property name was the test.
    const readings = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: AbortSignal.abort() });',
      "const controller = new AbortController();",
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: controller.signal });',
      'await callDaemon(bridge, "repo.workspaceList", request, {',
      "  signal: new AbortController().signal,",
      "});",
      "const staleSignal = controller.signal;",
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: staleSignal });',
    ]).map((site) => site.signalArgument);
    expect(readings).toStrictEqual([
      "unrecognised",
      "unrecognised",
      "unrecognised",
      "unrecognised",
    ]);
  });

  it("negative control: a member named signal off a name nothing binds is refused", () => {
    // The other half of the same claim, and the fail-closed direction: an ambient or a
    // global this scan cannot see is not admitted on the strength of its spelling, and
    // neither is a `signal` member that carries no value expression at all.
    const [ambient] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: ambientRound.signal });',
    ]);
    expect(ambient?.signalArgument).toBe("unrecognised");
    const [accessor] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, {',
      "  signal() {",
      "    return undefined;",
      "  },",
      "});",
    ]);
    expect(accessor?.signalArgument).toBe("unrecognised");
  });

  it("negative control: a signal a spread could replace is not a shown signal", () => {
    // THE PROPERTY THE FIRST READING STOPPED AT. Returning at the `signal` member read
    // the first line as `"present"`, and what that call hands the door is whatever
    // `options` carries — the later contribution wins, so a member this parse could
    // see was overwritten by one it could not. Both orders answer the same way on
    // purpose: making the verdict depend on which side the spread is written would
    // let a reordering edit flip a call from compliant to unsafe with no change to its
    // signal, and the fix is the same either way — hoist the spread into the value the
    // signal is read from.
    const [afterSignal] = plantedSites([
      "export function readBoundary(bridge, readScope, options) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal, ...options });',
      "}",
    ]);
    expect(afterSignal?.signalArgument).toBe("unrecognised");
    const readings = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { ...options, signal });',
      'await callDaemon(bridge, "repo.workspaceList", request, { signal, [key]: value });',
    ]).map((site) => site.signalArgument);
    expect(readings).toStrictEqual(["unrecognised", "unrecognised"]);
    // And the record rule still reads a signal-free spread as unreadable rather than
    // as this, because those two facts are different and only one of them names a
    // member the door might be handed.
    const [recordSite] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "session.join", request, { ...options });',
    ]);
    expect(recordSite?.signalArgument).toBe("opaque");
  });

  it("takes the last of two signal members, which is the one the door receives", () => {
    // A literal that assigns the member twice hands the door the second value, so the
    // scan that keeps reading is also the scan that reads the right one: a round's
    // signal written after a minted one is a read that IS stopped, and the reverse is
    // a read that is not.
    const [lastWins] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, {',
      "    signal: AbortSignal.abort(),",
      "    signal: round.signal,",
      "  });",
      "}",
    ]);
    expect(lastWins?.signalArgument).toBe("present");
    const [lastLoses] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, {',
      "    signal: round.signal,",
      "    signal: AbortSignal.abort(),",
      "  });",
      "}",
    ]);
    expect(lastLoses?.signalArgument).toBe("unrecognised");
  });

  it("negative control: a round is not a signal, and a signal is not a round", () => {
    // The two forms are read at their own positions rather than pooled. A `ReadRound`
    // handed on bare where a signal goes is not an `AbortSignal`, and a forwarded
    // signal has no `signal` member to read off it.
    const [bareRound] = plantedSites([
      "async function performRead(bridge, request, round: ReadRound) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal: round });',
      "}",
    ]);
    expect(bareRound?.signalArgument).toBe("unrecognised");
    const [nestedSignal] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: signal.signal });',
    ]);
    expect(nestedSignal?.signalArgument).toBe("unrecognised");
  });
});
