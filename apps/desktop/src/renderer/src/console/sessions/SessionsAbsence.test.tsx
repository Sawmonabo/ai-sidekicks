// Which kind of nothing the sessions destination draws, per reason it has none: a read
// still in flight says nothing about the node, and a served read with no rows says the
// node answered and has none.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionDirectoryState } from "../seats/index.js";
import { SessionsAbsence } from "./SessionsAbsence.js";

function renderAbsence(directory: SessionDirectoryState): void {
  render(<SessionsAbsence directory={directory} action={<button type="button">Start</button>} />);
}

describe("SessionsAbsence — one absence per reason there is none", () => {
  afterEach(() => {
    cleanup();
  });

  it("says the node answered and has none when the read was served empty", () => {
    renderAbsence({ status: "served", sessions: [] });

    expect(screen.getByText("There are no sessions on this node yet.")).toBeTruthy();
  });

  it("says nothing about the node while the read is in flight", () => {
    renderAbsence({ status: "reading" });

    expect(screen.getByText("Reading the sessions on this node.")).toBeTruthy();
    expect(screen.queryByText(/no sessions on this node/u)).toBeNull();
  });
});
