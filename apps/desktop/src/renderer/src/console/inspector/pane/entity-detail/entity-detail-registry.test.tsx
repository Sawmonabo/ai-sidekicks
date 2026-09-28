// One record per kind that has one, and four states for every one of them.
//
// The cases run over the table's own keys rather than over a list written here, so a
// kind given a record arrives in this file as cases.
//
// The four states are asserted through the REAL store — `initialise` and
// `markDegraded` are what a session does to itself — rather than through
// hand-built props, because the ranking under test is a claim about what those
// three store readings mean together.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleEntityKind } from "../../../store/index.js";
import { ENTITY_DETAIL_BY_KIND, type EntityDetailKind } from "./entity-detail-registry.js";
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
        attributedTo: "user-1",
        body: {
          name: "main",
          runVersion: 3,
          previousState: "running",
          repoMountId: "mount-1",
          workspaceId: "workspace-1",
          worktreeId: "worktree-1",
          actor: "user-1",
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
  });
  return store;
}

function renderRecord(
  store: SessionStore,
  kind: EntityDetailKind,
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

const KINDS_WITH_A_RECORD = Object.keys(ENTITY_DETAIL_BY_KIND) as EntityDetailKind[];

describe.each(KINDS_WITH_A_RECORD)("the %s record", (kind) => {
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
