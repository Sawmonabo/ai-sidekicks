// What the partitioned store buys, measured in renders.
//
// The whole reason `SessionStoreState` is a map per entity KIND rather than one
// flat map is that a row must re-render when its own entity changes and NOT when
// its neighbour does. That is a property nothing else in the tree can check: it is
// invisible to a snapshot assertion, invisible to a type, and it degrades silently
// — a selector that started building a value instead of returning a stored one
// still renders the right thing, just on every event in the session.
//
// So this file counts renders. Every count has its opposite asserted in the same
// case, because "row two did not re-render" is worthless unless row one did.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import {
  useOpenSessionStore,
  useSessionEntity,
  useSessionInitialised,
  useSessionPartition,
  useSessionStore,
} from "./hooks.js";
import { SessionStoreRegistry, type SessionSnapshotReader } from "./session-store-registry.js";
import type { SessionStore } from "./session-store.js";

const readsNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

function runIdOf(event: ConsoleSessionEvent): string {
  const raw = event.payload?.["runId"];
  return typeof raw === "string" ? raw : "unknown-run";
}

const projectors: EntityProjectorRegistry = {
  "run.starting": (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: runIdOf(event), state: `state-${String(event.sequence)}` },
    },
  ],
  "channel.created": (event) => [
    {
      operation: "upsert",
      entity: { kind: "channel", id: runIdOf(event), state: "open" },
    },
  ],
};

function eventAt(sequence: number, kind: string, entityId: string): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    payload: { runId: entityId },
  };
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

/** One ledger row, subscribed to exactly one entity. The narrowest subscription. */
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
function ChannelList(props: PartitionProps): React.JSX.Element {
  const channels = useSessionPartition(props.store, "channel");
  props.tally.record("channel-list");
  return <span data-testid="channel-count">{String(Object.keys(channels).length)}</span>;
}

function StoreHeader(props: PartitionProps): React.JSX.Element {
  const initialised = useSessionInitialised(props.store);
  const cursor = useSessionStore(props.store, (state) => state.cursor);
  props.tally.record("header");
  return (
    <span data-testid="header">{`${initialised ? "ready" : "loading"}:${String(cursor)}`}</span>
  );
}

describe("useSessionEntity — a row re-renders for its own entity and no other", () => {
  it("leaves the neighbouring row alone while re-rendering the touched one", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialise({
      cursor: 0,
      entities: [
        { kind: "run", id: "run-1", state: "queued" },
        { kind: "run", id: "run-2", state: "queued" },
      ],
      participantJoinLog: [],
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
    // …and its neighbour did not, even though both subscribe to the same store and
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
    store.initialise({
      cursor: 0,
      entities: [{ kind: "run", id: "run-1", state: "queued" }],
      participantJoinLog: [],
    });
    const tally = new RenderTally();

    const view = render(
      <>
        <RunRow store={store} runId="run-1" tally={tally} />
        <ChannelList store={store} tally={tally} />
      </>,
    );
    const rowRenders = tally.countFor("row-run-1");
    const listRenders = tally.countFor("channel-list");

    act(() => {
      registry.enqueue("session-1", [eventAt(1, "channel.created", "channel-1")]);
      clock.runFrame();
    });

    // The partition subscriber re-rendered — which is the negative control that
    // makes the row's silence meaningful rather than a store that stopped
    // notifying anybody.
    expect(tally.countFor("channel-list")).toBe(listRenders + 1);
    expect(view.getByTestId("channel-count").textContent).toBe("1");
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
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
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

describe("useSessionInitialised / useSessionStore — the store's own facts", () => {
  it("reports loading before a read lands and ready after it", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({ read: readsNothing, clock });
    const store = registry.open("session-1");
    const tally = new RenderTally();

    const view = render(<StoreHeader store={store} tally={tally} />);
    expect(view.getByTestId("header").textContent).toBe("loading:-1");

    act(() => {
      store.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });

    expect(view.getByTestId("header").textContent).toBe("ready:4");
    view.unmount();
    registry.disposeAll();
  });
});

describe("useOpenSessionStore — components resolve a store, never construct one", () => {
  it("follows the registry as a session opens and closes", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({ read: readsNothing, clock });
    const resolved: (SessionStore | undefined)[] = [];

    function StoreProbe(): React.JSX.Element {
      const store = useOpenSessionStore(registry, "session-1");
      resolved.push(store);
      return <span data-testid="probe">{store === undefined ? "none" : store.sessionId}</span>;
    }

    const view = render(<StoreProbe />);
    // A session that is not open is a real answer the surface renders, and NOT a
    // reason to open one from inside a render pass React may discard.
    expect(view.getByTestId("probe").textContent).toBe("none");
    expect(registry.openCount).toBe(0);

    let opened: SessionStore | undefined;
    act(() => {
      opened = registry.open("session-1");
    });
    expect(view.getByTestId("probe").textContent).toBe("session-1");
    expect(resolved.at(-1)).toBe(opened);

    act(() => {
      registry.close("session-1");
    });
    expect(view.getByTestId("probe").textContent).toBe("none");

    view.unmount();
    registry.disposeAll();
  });

  it("resolves nothing for a session id the caller does not have yet", () => {
    // The negative control for the case above: an undefined id must not resolve to
    // whichever session happens to be open.
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    registry.open("session-1");

    function StoreProbe(): React.JSX.Element {
      const store = useOpenSessionStore(registry, undefined);
      return <span data-testid="probe">{store === undefined ? "none" : store.sessionId}</span>;
    }

    const view = render(<StoreProbe />);
    expect(view.getByTestId("probe").textContent).toBe("none");

    view.unmount();
    registry.disposeAll();
  });
});
