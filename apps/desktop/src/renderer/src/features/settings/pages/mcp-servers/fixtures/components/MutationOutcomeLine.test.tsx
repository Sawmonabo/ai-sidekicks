// How a change settles in place: one line per grade saying when it takes effect, and one line per
// running session it failed on, named as the session list names it, and drawn only once the list
// names it. No grade, outcome value, error code, session id or loading word reaches the line.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  McpApplicationGrade,
  McpLiveApplicationResult,
} from "@ai-sidekicks/contracts/mcp/server";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { ManualClock } from "#renderer/lib/clock.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionListEntry } from "#renderer/store/session/directory/state.test-support.js";
import type { McpMutationOutcome } from "../mutation.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

afterEach(() => {
  cleanup();
});

const TITLED_SESSION = "019b7892-1a00-7c31-8110-cca0117a0601" as SessionId;
const UNTITLED_CHAT = "019b7892-1a00-7c31-8110-cca0117a0602" as SessionId;
const UNTITLED_PROJECT = "019b7892-1a00-7c31-8110-cca0117a0603" as SessionId;
const UNLISTED_SESSION = "019b7892-1a00-7c31-8110-cca0117a0604" as SessionId;
const APPLIED_SESSION = "019b7892-1a00-7c31-8110-cca0117a0605" as SessionId;

const DIRECTORY: SessionDirectoryState = {
  status: "served",
  sessions: [
    sessionListEntry({ sessionId: TITLED_SESSION, name: "Refresh-token expiry" }),
    sessionListEntry({ sessionId: UNTITLED_CHAT, shape: "chat" }),
    sessionListEntry({ sessionId: UNTITLED_PROJECT }),
    sessionListEntry({ sessionId: APPLIED_SESSION, name: "Tidy the docs" }),
  ],
};

function settledOn(
  grades: readonly McpApplicationGrade[],
  liveResults?: readonly McpLiveApplicationResult[],
): McpMutationOutcome {
  return {
    kind: "settled",
    binding: { provider: "codex", scope: "user", serverName: "issue-tracker" },
    settlement: { grades, liveResults },
  };
}

function linesOf(container: HTMLElement): readonly (string | null)[] {
  return [...container.querySelectorAll(".meridian-mcp__outcome p")].map(
    (line) => line.textContent,
  );
}

describe("MutationOutcomeLine", () => {
  it("says when each grade takes effect, naming the provider whose settings it reached", () => {
    const drawn: readonly [McpApplicationGrade, string][] = [
      ["live_reconcile", "Applied to running sessions."],
      ["user_config_write", "Saved to Codex's settings. New sessions use it."],
      ["next_run", "Saved. The next session uses it."],
      ["daemon_enforced", "In force now."],
    ];
    for (const [grade, line] of drawn) {
      const { container, unmount } = render(
        <MutationOutcomeLine
          outcome={settledOn([grade])}
          sessionDirectory={DIRECTORY}
          clock={new ManualClock(0)}
        />,
        { wrapper: LiveAnnouncerProvider },
      );
      expect(linesOf(container)).toStrictEqual([line]);
      expect(container.textContent).not.toContain(grade);
      unmount();
    }
  });

  it("names each running session the change failed on as the session list names it", () => {
    const failedOn = (sessionId: SessionId): McpLiveApplicationResult => ({
      sessionId,
      bindingId: `leg-${sessionId}`,
      outcome: "failed",
      errorCode: "mcp.config_write_conflict",
    });
    const { container } = render(
      <MutationOutcomeLine
        outcome={settledOn(
          ["user_config_write"],
          [
            { sessionId: APPLIED_SESSION, bindingId: "leg-applied", outcome: "applied" },
            failedOn(TITLED_SESSION),
            failedOn(UNTITLED_CHAT),
            failedOn(UNTITLED_PROJECT),
            failedOn(UNLISTED_SESSION),
          ],
        )}
        sessionDirectory={DIRECTORY}
        clock={new ManualClock(0)}
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    expect(linesOf(container)).toStrictEqual([
      "Saved to Codex's settings. New sessions use it.",
      "Refresh-token expiry is still running with the old setting.",
      "New chat is still running with the old setting.",
      "New session is still running with the old setting.",
    ]);
    const untitledNames = [...container.querySelectorAll(".meridian-mcp__untitled-session")].map(
      (name) => name.textContent,
    );
    expect(untitledNames).toStrictEqual(["New chat", "New session"]);
    // Read out as drawn, the names included.
    expect(liveRegionText(container, "polite")).toBe(
      "Saved to Codex's settings. New sessions use it. " +
        "Refresh-token expiry is still running with the old setting. " +
        "New chat is still running with the old setting. " +
        "New session is still running with the old setting.",
    );
    for (const hidden of [TITLED_SESSION, "mcp.config_write_conflict", "failed", "applied"]) {
      expect(container.textContent).not.toContain(hidden);
    }
  });

  it("draws a failed session's line only once the session list names it", () => {
    const outcome = settledOn(
      ["user_config_write"],
      [
        {
          sessionId: UNLISTED_SESSION,
          bindingId: "leg-unlisted",
          outcome: "failed",
          errorCode: "mcp.config_write_conflict",
        },
      ],
    );
    const drawOver = (sessionDirectory: SessionDirectoryState): React.JSX.Element => (
      <MutationOutcomeLine
        outcome={outcome}
        sessionDirectory={sessionDirectory}
        clock={new ManualClock(0)}
      />
    );
    const { container, rerender } = render(drawOver({ status: "reading" }), {
      wrapper: LiveAnnouncerProvider,
    });
    expect(linesOf(container)).toStrictEqual(["Saved to Codex's settings. New sessions use it."]);
    expect(container.textContent).not.toContain("Loading…");

    rerender(drawOver(DIRECTORY));
    expect(linesOf(container)).toStrictEqual(["Saved to Codex's settings. New sessions use it."]);

    rerender(
      drawOver({
        status: "served",
        sessions: [
          ...DIRECTORY.sessions,
          sessionListEntry({ sessionId: UNLISTED_SESSION, name: "Fix login" }),
        ],
      }),
    );
    expect(linesOf(container)).toStrictEqual([
      "Saved to Codex's settings. New sessions use it.",
      "Fix login is still running with the old setting.",
    ]);
  });
});
