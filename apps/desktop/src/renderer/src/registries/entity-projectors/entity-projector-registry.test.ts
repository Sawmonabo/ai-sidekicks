// The projector registry's own rules, driven directly: one owner per event kind, refused by
// name on a conflict, and a snapshot that does not move under a store for a session's life.

import { describe, expect, it } from "vitest";

import type {
  ProjectedSessionEvent,
  EntityMutation,
} from "@renderer/store/session/entities/entities.js";
import { EntityProjectorRegistry } from "./entity-projector-registry.js";

/** A kind no taxonomy registers, so nothing else claims it. */
const PROBE_EVENT_KIND = "probe.registered";

/** A projector that records the event kind it saw. */
function probeProjector(
  entityId: string,
): (event: ProjectedSessionEvent) => readonly EntityMutation[] {
  return (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: entityId, state: event.kind },
    } satisfies EntityMutation,
  ];
}

describe("the console's entity-projector board — one owner per event kind", () => {
  it("refuses a second owner's claim on one kind, naming both", () => {
    // Never last-writer-wins: the fold that runs would depend on module evaluation order.
    const registry = new EntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");

    expect(() => {
      registry.register(PROBE_EVENT_KIND, probeProjector("second"), "composer");
    }).toThrowError(/transcript[\s\S]*composer/);
    // A rejected registration is not half-applied.
    expect(registry.ownerOf(PROBE_EVENT_KIND)).toBe("transcript");
  });

  it("lets one owner re-claim its own kind, as a hot reload does it", () => {
    // The owner-scoped policy, not plain `"throw"`: a module re-evaluating must not raise.
    const registry = new EntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");

    expect(() => {
      registry.register(PROBE_EVENT_KIND, probeProjector("second"), "transcript");
    }).not.toThrow();
  });

  it("negative control: two owners on two different kinds is not a conflict", () => {
    // Without it, a registry that refused every second registration would pass the case above.
    const registry = new EntityProjectorRegistry();

    expect(() => {
      registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");
      registry.register("probe.other", probeProjector("second"), "composer");
    }).not.toThrow();
    expect(registry.ownerOf("probe.other")).toBe("composer");
  });

  it("leaves a colliding batch exactly as it was, rather than half-claimed", () => {
    const registry = new EntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");

    expect(() => {
      registry.registerAll(
        { "probe.fresh": probeProjector("fresh"), [PROBE_EVENT_KIND]: probeProjector("clash") },
        "composer",
      );
    }).toThrow();
    expect(registry.ownerOf("probe.fresh")).toBeUndefined();
    expect(registry.ownerOf(PROBE_EVENT_KIND)).toBe("transcript");
  });
});

describe("the console's entity-projector board — the snapshot a store opens with", () => {
  it("carries every claimed kind, and is frozen", () => {
    // Frozen at runtime: a table that grew under an open store would fold one kind two ways.
    const registry = new EntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");

    const snapshot = registry.snapshot();

    expect(Object.keys(snapshot)).toStrictEqual([PROBE_EVENT_KIND]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not grow when the board does, so a store's fold is fixed at open", () => {
    const registry = new EntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");
    const taken = registry.snapshot();

    registry.register("probe.later", probeProjector("later"), "composer");

    expect(Object.keys(taken)).toStrictEqual([PROBE_EVENT_KIND]);
    // Negative control: the registry did change, so stability belongs to the snapshot.
    expect(Object.keys(registry.snapshot())).toContain("probe.later");
  });

  it("negative control: a fresh board claims nothing on its own", () => {
    // Every case above would pass over a board that reported kinds nobody registered.
    expect(new EntityProjectorRegistry().snapshot()).toStrictEqual({});
  });
});
