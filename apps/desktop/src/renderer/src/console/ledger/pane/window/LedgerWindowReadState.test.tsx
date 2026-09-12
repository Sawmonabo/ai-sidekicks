// The window's read state, held to the two facts the store has always carried and the
// pane never showed.
//
// Both cases drive a REAL store rather than a stubbed reading: the claim is that the
// pane follows `initialised` and `degradedCause`, and a fixture that published those
// two names itself would pass over a component reading neither.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LedgerWindowReadState } from "./LedgerWindowReadState.js";
import { SessionStore } from "../../../store/index.js";

function openStore(): SessionStore {
  return new SessionStore({ sessionId: "session-1" });
}

function readStateOf(sessionStore: SessionStore): HTMLElement {
  return render(<LedgerWindowReadState sessionStore={sessionStore} />).container;
}

describe("before the first read lands", () => {
  it("draws a window of row shells rather than an empty session", () => {
    const container = readStateOf(openStore());
    expect(container.querySelectorAll(".meridian-ledger-window-skeleton__row")).toHaveLength(12);
  });

  it("announces itself as a read in flight", () => {
    const skeleton = readStateOf(openStore()).querySelector(".meridian-ledger-window-skeleton");
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
  });
});

describe("when the first read itself failed", () => {
  it("says so rather than drawing shells for a read that is already over", () => {
    // `OpenSessionEntry` marks `read-failed` when the first read is refused or
    // rejects, and leaves the store uninitialised — so a pane that asked
    // "initialised?" first drew twelve `aria-busy` shells for as long as the failure
    // stood and never told anybody the read had ended.
    const sessionStore = openStore();
    sessionStore.markDegraded("read-failed");

    const container = readStateOf(sessionStore);

    expect(container.querySelectorAll(".meridian-ledger-window-skeleton__row")).toHaveLength(0);
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(container.textContent).toContain("Catching up.");
    expect(container.querySelector(".meridian-ledger-window-catch-up__cause")?.textContent).toBe(
      "read-failed",
    );
  });
});

describe("once the window has been read", () => {
  it("draws nothing at all while the projection is keeping up", () => {
    const sessionStore = openStore();
    sessionStore.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    expect(readStateOf(sessionStore).textContent).toBe("");
  });

  it("carries the catching-up mark while the store is behind, naming the cause", () => {
    const sessionStore = openStore();
    sessionStore.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    sessionStore.markDegraded("sequence-gap");
    const container = readStateOf(sessionStore);
    expect(container.textContent).toContain("Catching up.");
    expect(container.querySelector(".meridian-ledger-window-catch-up__cause")?.textContent).toBe(
      "sequence-gap",
    );
  });

  it("negative control: the shells are gone, so the two arms are never both drawn", () => {
    const sessionStore = openStore();
    sessionStore.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    sessionStore.markDegraded("stream-diverged");
    expect(
      readStateOf(sessionStore).querySelectorAll(".meridian-ledger-window-skeleton__row"),
    ).toHaveLength(0);
  });
});
