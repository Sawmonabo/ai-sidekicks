// The shared scaffolding every transcript-feed case is driven through.
//
// The feed's cases split by SUBJECT across several files — the rows, the absences,
// the narrowing, and the palette registration — and every one of them needs the same three
// things: a laid-out box, a mount under a bridge, and a way to press a contributed
// palette row. Written once here, on
// `features/transcript/timeline-rows.test-support.ts`' terms: a module beside the code it serves,
// consumed by tests and by nothing else.
//
// THE LOGS ARE NOT HERE. A store builder needs no DOM and no React, and the pane's
// pure-model cases read them without ever mounting anything, so they live in
// `transcript-logs.test-support.ts` and this file holds only what has to render.
//
// `happy-dom` answers zero for every geometry read, which is why anything that needs
// the virtualizer to have a range stubs the two reads the chokepoint makes —
// `TranscriptViewport.test.tsx`' stub, for its reason.

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

export const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;
export const SHORT_LOG_EVENT_COUNT = 10;
export const OVER_CAP_EVENT_COUNT: number = TRANSCRIPT_WINDOW_ROW_CAP + 50;

/**
 * Give the transcript a laid-out, scrollable box for the length of one case.
 *
 * Both reads are load-bearing and neither is the module under test: the
 * virtualizer treats a zero outer size as "no range at all", and the scroll
 * chokepoint clamps every write to `scrollHeight - clientHeight`.
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
 * Mount the feed under a bridge, because the transcript reads the console clock.
 *
 * `onRowMounted` is how a case reads the three decisions the list makes for a row:
 * they reach the row renderer as arguments and never as markup, so a case that only read
 * the DOM could not see any of them.
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
 * A row body that presses its own disclosure through the list's lease.
 *
 * The composed feed hands each row to whichever renderer is registered, and the
 * renderer that ships one is `TranscriptRow.tsx` — whose own suite proves it writes
 * the press to the lease. What a FEED case needs is the other half: that a write
 * reaches the window and comes back as the density the row renderer is handed. This row is
 * the smallest thing that can perform the write from inside the tree.
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
 * Contribute the transcript's palette rows into this window's real command registry.
 *
 * The real one rather than a private registry, because the seam under test is
 * exactly that a command contributed at COMPOSITION time reaches a feed mounted
 * later. A test-owned registry would prove the acts fire and nothing about that.
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
