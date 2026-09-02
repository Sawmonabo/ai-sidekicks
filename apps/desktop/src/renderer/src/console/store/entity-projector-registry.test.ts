// The projector board's own rules, apart from the composition that fills it.
//
// Two of them, and they are the reasons the board exists rather than a constant:
// one owner per event kind — refused by name on a conflict, never resolved by
// import order — and a snapshot a store can hold for a session's whole life without
// the table moving underneath it.
//
// The seam's behaviour through a real window is `frame/session-lifecycle`'s to
// prove; what is here is the registry's own, driven directly so a conflict is a
// value rather than a failure inside a render.

import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent, EntityMutation } from "./entities.js";
import { ConsoleEntityProjectorRegistry } from "./entity-projector-registry.js";

/** A probe kind no taxonomy registers, so nothing else can be claiming it. */
const PROBE_EVENT_KIND = "probe.registered";

/** A projector that names the event it saw, so a snapshot can be shown to hold it. */
function probeProjector(
  entityId: string,
): (event: ConsoleSessionEvent) => readonly EntityMutation[] {
  return (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: entityId, state: event.kind },
    } satisfies EntityMutation,
  ];
}

describe("the console's entity-projector board — one owner per event kind", () => {
  it("refuses a second owner's claim on one kind, naming both", () => {
    // Never last-writer-wins: two folds for one kind would make which one runs
    // depend on which family's module evaluated first, and the store would report a
    // partition built by whichever that happened to be.
    const registry = new ConsoleEntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "ledger");

    expect(() => {
      registry.register(PROBE_EVENT_KIND, probeProjector("second"), "composer");
    }).toThrowError(/ledger[\s\S]*composer/);
    // The first claim survives the refusal — a rejected registration is not a
    // half-applied one.
    expect(registry.ownerOf(PROBE_EVENT_KIND)).toBe("ledger");
  });

  it("lets one owner re-claim its own kind, as a hot reload does it", () => {
    // The other half of the owner-scoped policy, and the reason it is not plain
    // `"throw"`: a family's module re-evaluating must not raise.
    const registry = new ConsoleEntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "ledger");

    expect(() => {
      registry.register(PROBE_EVENT_KIND, probeProjector("second"), "ledger");
    }).not.toThrow();
  });

  it("negative control: two owners on two different kinds is not a conflict", () => {
    // Without it the case above would hold over a registry that refused every
    // second registration, which is a board no two families could share.
    const registry = new ConsoleEntityProjectorRegistry();

    expect(() => {
      registry.register(PROBE_EVENT_KIND, probeProjector("first"), "ledger");
      registry.register("probe.other", probeProjector("second"), "composer");
    }).not.toThrow();
    expect(registry.ownerOf("probe.other")).toBe("composer");
  });

  it("leaves a colliding batch exactly as it was, rather than half-claimed", () => {
    const registry = new ConsoleEntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "ledger");

    expect(() => {
      registry.registerAll(
        { "probe.fresh": probeProjector("fresh"), [PROBE_EVENT_KIND]: probeProjector("clash") },
        "composer",
      );
    }).toThrow();
    expect(registry.ownerOf("probe.fresh")).toBeUndefined();
    expect(registry.ownerOf(PROBE_EVENT_KIND)).toBe("ledger");
  });
});

describe("the console's entity-projector board — the snapshot a store opens with", () => {
  it("carries every claimed kind, and is frozen", () => {
    // Frozen at runtime rather than merely typed `Readonly`: a store folds for as
    // long as its session is open, and a table that grew underneath it would fold
    // two events of one kind two different ways inside one session.
    const registry = new ConsoleEntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "ledger");

    const snapshot = registry.snapshot();

    expect(Object.keys(snapshot)).toStrictEqual([PROBE_EVENT_KIND]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not grow when the board does, so a store's fold is fixed at open", () => {
    const registry = new ConsoleEntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "ledger");
    const taken = registry.snapshot();

    registry.register("probe.later", probeProjector("later"), "composer");

    expect(Object.keys(taken)).toStrictEqual([PROBE_EVENT_KIND]);
    // The negative control for the case above: the registry really did change, so
    // the snapshot's stability is a property of the snapshot rather than of a board
    // nothing wrote to.
    expect(Object.keys(registry.snapshot())).toContain("probe.later");
  });

  it("negative control: a fresh board claims nothing on its own", () => {
    // Every case above reads a snapshot, and all of them would pass over a board
    // that reported kinds nobody registered.
    expect(new ConsoleEntityProjectorRegistry().snapshot()).toStrictEqual({});
  });
});
