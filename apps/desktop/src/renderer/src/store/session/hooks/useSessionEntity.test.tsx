// What the partitioned store buys, measured in renders.
//
// The whole reason `SessionStoreState` is a map per entity KIND rather than one
// flat map is that a row must re-render when its own entity changes and NOT when
// its neighbor does. That is a property nothing else in the tree can check: it is
// invisible to a snapshot assertion, invisible to a type, and it degrades silently
// — a selector that started building a value instead of returning a stored one
// still renders the right thing, just on every event in the session.
//
// So this file counts renders. Every count has its opposite asserted in the same
// case, because "row two did not re-render" is worthless unless row one did.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import type { ProjectedSessionEvent, EntityProjectorTable } from "../entities/entities.js";
import { useSessionEntity, useSessionPartition } from "./useOpenSessionStore.js";
import { type SessionSnapshotReader } from "../open-session-entry.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { SessionStoreRegistry } from "../session-store-registry.js";
import type { SessionStore } from "../session-store.js";

const readsNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

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
  "artifact.published": (event) => [
    {
      operation: "upsert",
      entity: { kind: "artifact", id: runIdOf(event), state: "open" },
    },
  ],
};

/** One event at `sequence`, carrying the entity id both projectors key on. */
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

interface PartitionProps {
  readonly store: SessionStore;
  readonly tally: RenderTally;
}

/** A list subscribed to a whole kind. Re-renders when THAT kind changes. */
function ArtifactList(props: PartitionProps): React.JSX.Element {
  const artifacts = useSessionPartition(props.store, "artifact");
  props.tally.record("artifact-list");
  return <span data-testid="artifact-count">{String(Object.keys(artifacts).length)}</span>;
}

describe("useSessionEntity — a row re-renders for its own entity and no other", () => {
  it("leaves the neighboring row alone while re-rendering the touched one", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
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

  it("re-renders neither row when a DIFFERENT kind changes", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialize({
      cursor: 0,
      entities: [{ kind: "run", id: "run-1", state: "queued" }],
    });
    const tally = new RenderTally();

    const view = render(
      <>
        <RunRow store={store} runId="run-1" tally={tally} />
        <ArtifactList store={store} tally={tally} />
      </>,
    );
    const rowRenders = tally.countFor("row-run-1");
    const listRenders = tally.countFor("artifact-list");

    act(() => {
      registry.enqueue("session-1", [eventAt(1, "artifact.published", "artifact-1")]);
      clock.runFrame();
    });

    // The partition subscriber re-rendered — which is the negative control that
    // makes the row's silence meaningful rather than a store that stopped
    // notifying anybody.
    expect(tally.countFor("artifact-list")).toBe(listRenders + 1);
    expect(view.getByTestId("artifact-count").textContent).toBe("1");
    expect(tally.countFor("row-run-1")).toBe(rowRenders);

    view.unmount();
    registry.disposeAll();
  });

  it("renders one row for a burst, not one per event", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialize({ cursor: 0, entities: [] });
    const tally = new RenderTally();

    const view = render(<RunRow store={store} runId="run-1" tally={tally} />);
    const before = tally.countFor("row-run-1");

    act(() => {
      registry.enqueue("session-1", [
        eventAt(1, "run.starting", "run-1"),
        eventAt(2, "run.starting", "run-1"),
        eventAt(3, "run.starting", "run-1"),
      ]);
      clock.runFrame();
    });

    // Three events touching one entity: one drain, one transition, one render.
    expect(tally.countFor("row-run-1")).toBe(before + 1);
    expect(view.getByTestId("row-run-1").textContent).toBe("state-3");

    view.unmount();
    registry.disposeAll();
  });
});
