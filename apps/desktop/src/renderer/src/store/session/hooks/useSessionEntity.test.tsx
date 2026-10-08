// A row subscribed to one entity shows that entity's new state when an event lands, and its
// neighbor is left alone. Render counts are the measure, since a selector that builds a value
// still renders correctly, just on every event.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import type { ProjectedSessionEvent, EntityProjectorTable } from "../entities/vocabulary.js";
import { useSessionEntity } from "./useOpenSessionStore.js";
import {
  openingPageLimit,
  offScreenRowLimit,
  readsNothing,
} from "#test/helpers/session/store/fixtures.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { SessionStoreRegistry } from "../registry.js";
import type { SessionStore } from "../store.js";

function runIdOf(event: ProjectedSessionEvent): string {
  const raw = event.payload?.["runId"];
  return typeof raw === "string" ? raw : "unknown-run";
}

const projectors: EntityProjectorTable = {
  "run.starting": (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: runIdOf(event), state: `state-${String(event.sequence)}` },
    },
  ],
};

/** One event at `sequence`, carrying the entity id the projector keys on. */
function eventAt(sequence: number, kind: string, entityId: string): ProjectedSessionEvent {
  return eventOfKind("session-1", kind, sequence, { runId: entityId });
}

/** Render tallies, keyed by the label the component under test was given. */
class RenderTally {
  readonly #countsByLabel = new Map<string, number>();

  public record(label: string): void {
    this.#countsByLabel.set(label, (this.#countsByLabel.get(label) ?? 0) + 1);
  }

  public countFor(label: string): number {
    return this.#countsByLabel.get(label) ?? 0;
  }
}

interface RowProps {
  readonly store: SessionStore;
  readonly runId: string;
  readonly tally: RenderTally;
}

/** One transcript row, subscribed to exactly one entity. The narrowest subscription. */
function RunRow(props: RowProps): React.JSX.Element {
  const entity = useSessionEntity(props.store, { kind: "run", id: props.runId });
  props.tally.record(`row-${props.runId}`);
  return <span data-testid={`row-${props.runId}`}>{entity?.state ?? "absent"}</span>;
}

describe("useSessionEntity — a row re-renders for its own entity and no other", () => {
  it("leaves the neighboring row alone while re-rendering the touched one", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      openingPageLimit,
      offScreenRowLimit,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialize({
      cursor: 0,
      entities: [
        { kind: "run", id: "run-1", state: "queued" },
        { kind: "run", id: "run-2", state: "queued" },
      ],
    });
    const tally = new RenderTally();

    const view = render(
      <>
        <RunRow store={store} runId="run-1" tally={tally} />
        <RunRow store={store} runId="run-2" tally={tally} />
      </>,
    );

    const firstRowRenders = tally.countFor("row-run-1");
    const secondRowRenders = tally.countFor("row-run-2");

    act(() => {
      registry.enqueue("session-1", [eventAt(1, "run.starting", "run-1")]);
      clock.runFrame();
    });

    // The touched row re-rendered…
    expect(tally.countFor("row-run-1")).toBe(firstRowRenders + 1);
    expect(view.getByTestId("row-run-1").textContent).toBe("state-1");
    // …and its neighbor did not, even though both subscribe to the same store and
    // the same notification reached both.
    expect(tally.countFor("row-run-2")).toBe(secondRowRenders);
    expect(view.getByTestId("row-run-2").textContent).toBe("queued");

    view.unmount();
    registry.disposeAll();
  });
});
