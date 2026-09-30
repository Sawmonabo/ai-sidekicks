// The snapshot a session store opens with does not move under it for the session's life.

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

describe("the console's entity-projector board — the snapshot a store opens with", () => {
  it("does not grow when the board does, so a store's fold is fixed at open", () => {
    const registry = new EntityProjectorRegistry();
    registry.register(PROBE_EVENT_KIND, probeProjector("first"), "transcript");
    const taken = registry.snapshot();

    registry.register("probe.later", probeProjector("later"), "composer");

    expect(Object.keys(taken)).toStrictEqual([PROBE_EVENT_KIND]);
    // Negative control: the registry did change, so stability belongs to the snapshot.
    expect(Object.keys(registry.snapshot())).toContain("probe.later");
  });
});
