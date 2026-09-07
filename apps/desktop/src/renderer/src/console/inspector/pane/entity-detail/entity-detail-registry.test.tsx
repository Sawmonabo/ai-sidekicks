// One record per entity kind, and four states for every one of them.
//
// The cases run over `CONSOLE_ENTITY_KINDS` itself rather than over a list written
// here: a thirteenth kind added to the store's enumeration has to arrive in this file
// as a failure, and a list restated beside the closed set would let it arrive as
// nothing at all.
//
// The four states are asserted through the REAL store — `initialise` and
// `markDegraded` are what a session does to itself — rather than through
// hand-built props, because the ranking under test is a claim about what those
// three store readings mean together.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_ENTITY_KINDS,
  SessionStore,
  type ConsoleEntityKind,
} from "../../../store/index.js";
import { ENTITY_DETAIL_BY_KIND } from "./entity-detail-registry.js";
import { InspectedEntity } from "./InspectedEntity.js";

const SESSION_ID = "session-inspector";
const PRESENT_ID = "entity-present";
const ABSENT_ID = "entity-absent";

/** A store that has answered nothing yet. */
function unreadStore(): SessionStore {
  return new SessionStore({ sessionId: SESSION_ID });
}

/** A store that has answered, holding one record of the given kind. */
function readStore(kind: ConsoleEntityKind): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: 1,
    entities: [
      {
        kind,
        id: PRESENT_ID,
        state: "ready",
        touchedAt: "2026-01-01T16:30:05.000Z",
        attributedTo: "participant-1",
        body: {
          role: "owner",
          identityHandle: "ada",
          name: "main",
          runVersion: 3,
          previousState: "running",
          repoMountId: "mount-1",
          workspaceId: "workspace-1",
          worktreeId: "worktree-1",
          actor: "participant-1",
          contentType: "text/plain",
          byteLength: 4096,
          category: "file_write",
          decision: "granted",
          expiresAt: null,
          definitionId: "definition-1",
          phase: "review",
          parkReason: "provider_limit",
          url: "https://example.invalid/page",
          title: "A page",
        },
      },
    ],
    participantJoinLog: ["participant-1"],
  });
  return store;
}

function renderRecord(
  store: SessionStore,
  kind: ConsoleEntityKind,
  id: string,
  linkedSourcePaneId?: string,
): HTMLElement {
  const { container } = render(
    <InspectedEntity
      entityRef={{ kind, id }}
      sessionStore={store}
      linkedSourcePaneId={linkedSourcePaneId}
    />,
  );
  return container;
}

describe("the detail table is total over the entity kinds", () => {
  it("carries one record body per declared kind, and no other key", () => {
    expect(Object.keys(ENTITY_DETAIL_BY_KIND).sort()).toStrictEqual(
      [...CONSOLE_ENTITY_KINDS].sort(),
    );
  });

  it("negative control: a table missing a kind is rejected", () => {
    // Without this the case above would also pass over a comparison that ignored
    // its right-hand side.
    const { session: _session, ...withoutSession } = ENTITY_DETAIL_BY_KIND;
    expect(Object.keys(withoutSession).sort()).not.toStrictEqual([...CONSOLE_ENTITY_KINDS].sort());
  });
});

describe.each([...CONSOLE_ENTITY_KINDS])("the %s record", (kind) => {
  it("says the read is in flight before the store has answered", () => {
    const container = renderRecord(unreadStore(), kind, PRESENT_ID);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-entity-record")).toBeNull();
  });

  it("ranks a known-incomplete projection above the absence it would otherwise report", () => {
    const store = readStore(kind);
    store.markDegraded("sequence-gap");
    const container = renderRecord(store, kind, ABSENT_ID);
    // The record is missing AND the projection is incomplete. Reporting "there is
    // none" here would assert a fact the daemon has withdrawn, so the degraded arm
    // wins and carries the store's own word for why.
    expect(container.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.textContent).toContain("sequence-gap");
  });

  it("reports the absence once the read has answered and holds no such record", () => {
    const container = renderRecord(readStore(kind), kind, ABSENT_ID);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-entity-record")).toBeNull();
  });

  it("renders the record, its identifier verbatim, and its state", () => {
    const container = renderRecord(readStore(kind), kind, PRESENT_ID);
    const record = container.querySelector(".meridian-entity-record");
    expect(record).not.toBeNull();
    expect(record?.textContent).toContain(PRESENT_ID);
    expect(record?.textContent).toContain("ready");
    expect(container.querySelectorAll(".meridian-entity-record__facet").length).toBeGreaterThan(0);
  });

  it("states the link to a source pane only when it was given one", () => {
    const withoutLink = renderRecord(readStore(kind), kind, PRESENT_ID);
    expect(withoutLink.querySelector(".meridian-entity-record__link")).toBeNull();
    const withLink = renderRecord(readStore(kind), kind, PRESENT_ID, "pane-source");
    expect(withLink.querySelector(".meridian-entity-record__link")?.textContent).toContain(
      "pane-source",
    );
  });
});

describe("the session record, which is composed rather than projected", () => {
  it("counts what the session holds instead of reading a count off a row", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({
      cursor: 1,
      entities: [
        { kind: "participant", id: "participant-1" },
        { kind: "participant", id: "participant-2" },
        { kind: "run", id: "run-1" },
      ],
      participantJoinLog: ["participant-1", "participant-2"],
    });
    const container = renderRecord(store, "session", SESSION_ID);
    const facets = [...container.querySelectorAll(".meridian-entity-record__facet")].map(
      (facet) => facet.textContent ?? "",
    );
    expect(facets.find((facet) => facet.startsWith("Participants"))).toContain("2");
    expect(facets.find((facet) => facet.startsWith("Runs"))).toContain("1");
  });

  it("negative control: the store's own session is a record even with no projected row", () => {
    // And an id that is NOT the open session's is still an absence, so the arm
    // above is a fact about this session rather than a body that always renders.
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({ cursor: 1, entities: [], participantJoinLog: [] });
    expect(
      renderRecord(store, "session", SESSION_ID).querySelector(".meridian-entity-record"),
    ).not.toBeNull();
    expect(
      renderRecord(store, "session", ABSENT_ID).querySelector(".meridian-entity-record"),
    ).toBeNull();
  });
});

describe("a member the record does not carry", () => {
  it("is named as not recorded rather than left blank or shown as a zero", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({
      cursor: 1,
      entities: [{ kind: "artifact", id: PRESENT_ID }],
      participantJoinLog: [],
    });
    const container = renderRecord(store, "artifact", PRESENT_ID);
    expect(container.querySelectorAll(".meridian-nothing--not-checked").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Not recorded");
  });

  it("negative control: a member the record DOES carry is a figure, not an absence", () => {
    const container = renderRecord(readStore("artifact"), "artifact", PRESENT_ID);
    const size = [...container.querySelectorAll(".meridian-entity-record__facet")].find((facet) =>
      (facet.textContent ?? "").startsWith("Size"),
    );
    expect(size?.textContent).toContain("KiB");
    expect(size?.querySelector(".meridian-nothing")).toBeNull();
  });
});
