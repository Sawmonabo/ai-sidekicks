// The readings under `Running sessions`: one line per running session that uses the server, the
// session as the session list names it and never by its id, its state word, and the reading's
// age, never an instant.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { McpServerLegStatus } from "@ai-sidekicks/contracts/mcp/server";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionListEntry } from "#renderer/store/session/directory/state.test-support.js";
import { ServerLegs } from "./ServerLegs.js";
import { liveBridgeWrapper, withAnnouncer } from "#test/helpers/app/frame-fixtures.js";

afterEach(() => {
  cleanup();
});

const NOW_MS = Date.UTC(2026, 0, 1, 9, 0, 0);
const TITLED_SESSION = "019b7892-1a00-7c31-8110-cca0117a0701" as SessionId;
const UNTITLED_SESSION = "019b7892-1a00-7c31-8110-cca0117a0702" as SessionId;
const UNLISTED_SESSION = "019b7892-1a00-7c31-8110-cca0117a0703" as SessionId;

const DIRECTORY: SessionDirectoryState = {
  status: "served",
  sessions: [
    sessionListEntry({ sessionId: TITLED_SESSION, name: "Fix login" }),
    sessionListEntry({ sessionId: UNTITLED_SESSION, shape: "chat" }),
  ],
};

const LEGS: readonly McpServerLegStatus[] = [
  {
    sessionId: TITLED_SESSION,
    bindingId: "leg-titled",
    status: "connected",
    observedAt: "2026-01-01T08:58:00.000Z",
  },
  { sessionId: UNTITLED_SESSION, bindingId: "leg-untitled", status: "failed" },
  { sessionId: UNLISTED_SESSION, bindingId: "leg-unlisted", status: "unknown" },
];

describe("ServerLegs", () => {
  it("reads each session, its state word and the reading's age, or the state word alone", () => {
    const { container } = render(
      <ServerLegs legs={LEGS} sessionDirectory={DIRECTORY} nowMilliseconds={NOW_MS} />,
      { wrapper: withAnnouncer(liveBridgeWrapper()) },
    );
    const lines = [...container.querySelectorAll(".meridian-mcp__leg")].map((line) =>
      [...line.childNodes].map((part) => part.textContent),
    );
    expect(lines).toStrictEqual([
      ["Fix login", "·", "Connected", "· updated", "2 minutes ago"],
      ["New chat", "·", "Failed"],
      ["Unknown"],
    ]);
    expect(container.textContent).not.toContain(UNLISTED_SESSION);
  });

  it("negative control: while the list is read no line carries a name, never its id", () => {
    const { container } = render(
      <ServerLegs legs={LEGS} sessionDirectory={{ status: "reading" }} nowMilliseconds={NOW_MS} />,
      { wrapper: withAnnouncer(liveBridgeWrapper()) },
    );
    const lines = [...container.querySelectorAll(".meridian-mcp__leg")].map((line) =>
      [...line.childNodes].map((part) => part.textContent),
    );
    expect(lines).toStrictEqual([
      ["Connected", "· updated", "2 minutes ago"],
      ["Failed"],
      ["Unknown"],
    ]);
    for (const sessionId of [TITLED_SESSION, UNTITLED_SESSION, UNLISTED_SESSION]) {
      expect(container.textContent).not.toContain(sessionId);
    }
  });

  it("says no running session uses the server when none does", () => {
    const { container } = render(
      <ServerLegs legs={undefined} sessionDirectory={DIRECTORY} nowMilliseconds={NOW_MS} />,
      { wrapper: withAnnouncer(liveBridgeWrapper()) },
    );
    expect(container.textContent).toBe("No running session uses this server.");
  });
});
