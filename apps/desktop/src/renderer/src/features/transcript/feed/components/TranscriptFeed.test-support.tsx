// The shared scaffolding for the transcript-feed cases: a laid-out box, a mount under a bridge,
// and a way to press a contributed palette row. The logs live in `transcript-logs.test-support.ts`
// because a store builder needs no DOM. `happy-dom` answers zero for every geometry read, so a
// case needing a virtualizer range stubs the two reads the scroll chokepoint makes.

import { act, render } from "@testing-library/react";
import { vi } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../../frame/frame-caps.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { useRetainedRowState } from "../../viewport/hooks/useRetainedRowState.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../../fixtures/scenarios/empty-session.js";
import { commandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import {
  TRANSCRIPT_COMMAND_OWNER,
  registerTranscriptCommands,
} from "../../contributions/commands.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type TranscriptRowProps } from "../../transcript-row-renderer.js";
import { TranscriptFeed } from "./TranscriptFeed.js";

/** The height the laid-out viewport reports. */
export const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;
/** An event count that fits inside the window cap. */
export const SHORT_LOG_EVENT_COUNT = 10;
/** An event count past the window cap, so the cap takes rows. */
export const OVER_CAP_EVENT_COUNT: number = TRANSCRIPT_WINDOW_ROW_CAP + 50;

/**
 * Give the transcript a laid-out, scrollable box for the length of one case. The virtualizer
 * treats a zero outer size as no range, and the scroll chokepoint clamps every write to
 * `scrollHeight - clientHeight`.
 */
export function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    LAID_OUT_CONTENT_HEIGHT_PX,
  );
}

/**
 * Mount the feed under a bridge, because the transcript reads the console clock. `onRowMounted`
 * lets a case read the three decisions the list makes for a row, which reach the row renderer as
 * arguments and never as markup.
 */
export function renderFeed(
  sessionStore: SessionStore,
  onRowMounted?: (mount: TranscriptRowProps) => void,
  renderRowBody?: (mount: TranscriptRowProps) => React.JSX.Element,
): HTMLElement {
  const { container } = render(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      <TranscriptFeed
        sessionStore={sessionStore}
        renderTranscriptRow={(mount) => {
          onRowMounted?.(mount);
          return renderRowBody === undefined ? <p>{mount.row.summary}</p> : renderRowBody(mount);
        }}
        feedLabel="Transcript"
      />
    </FixtureBridgeProvider>,
  );
  const feed = container.querySelector(".meridian-transcript-feed");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("TranscriptFeed rendered no transcript element");
  }
  return feed;
}

/**
 * A row body that presses its own disclosure through the list's lease: the smallest thing that
 * can perform the write from inside the tree, so a feed case can check that the write comes back
 * as the density the row renderer is handed.
 */
export function LeasingRowBody(props: TranscriptRowProps): React.JSX.Element {
  const rowLease = useRetainedRowState();
  return (
    <button
      type="button"
      className="leasing-row"
      data-density={props.density}
      onClick={() => {
        rowLease.setLease(props.row.id, {
          density: props.density === "expanded" ? "collapsed" : "expanded",
          innerScrollTopPx: 0,
        });
      }}
    >
      {props.row.summary}
    </button>
  );
}

/**
 * Contribute the transcript's palette rows into this window's real command registry, because the
 * seam under test is that a command contributed at composition time reaches a feed mounted later.
 */
export function contributeTranscriptCommands(): void {
  registerTranscriptCommands(commandContributionRegistry);
}

/** Leave the window with none of the transcript's rows, so cases do not leak into each other. */
export function withdrawTranscriptCommands(): void {
  commandContributionRegistry.contribute({
    owner: TRANSCRIPT_COMMAND_OWNER,
    commands: [],
    keyBindings: [],
  });
}

/** Run one contributed command by id, the way the palette does. */
export function dispatchCommand(commandId: string): void {
  const command = commandRegistry
    .commandsFor({ sessionActive: true })
    .find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`no command named ${commandId} is contributed to this window`);
  }
  act(() => {
    void command.run();
  });
}
