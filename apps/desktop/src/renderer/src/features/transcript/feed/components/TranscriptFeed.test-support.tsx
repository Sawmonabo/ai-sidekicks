// The shared scaffolding for the transcript-feed cases: a mount under a bridge and a way to press a
// contributed palette row. The logs live in `features/transcript/logs.test-support.ts` because a
// store builder needs no DOM; the laid-out box a virtualizer range needs is `withLaidOutViewport`
// in `features/transcript/viewport/controller.test-support.ts`.

import { act, render } from "@testing-library/react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { useRetainedRowState } from "../../viewport/hooks/useRetainedRowState.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { commandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { registerTranscriptCommands } from "../../contributions/commands.js";
import { TRANSCRIPT_OWNER } from "../../contributions/screens.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptRowProps } from "../../rows/renderer.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript-page.js";
import { TranscriptFeed } from "./TranscriptFeed.js";

/** An event count short enough that the window never lets one of its rows go. */
export const SHORT_LOG_EVENT_COUNT = 10;
/**
 * An event count whose rows run many screen heights past the laid-out box, so the window lets
 * rows go from an ordinary open at the bottom.
 */
export const LONG_LOG_EVENT_COUNT = 450;

/**
 * Mount the feed under a bridge, because the transcript reads the app's clock. `onRowMounted`
 * lets a case read the three decisions the list makes for a row, which reach the row renderer as
 * arguments and never as markup. `messageAnchorCursor` opens the feed at that message,
 * `readTranscriptPage` is the `transcript.read` the feed reads its history with, `drawsBody` is
 * the row renderer's answer to which rows it draws, every row unless a case says otherwise, and
 * `fixture` the bridge whose frozen clock a case advances, a fresh one unless it says otherwise.
 */
export function renderFeed(
  sessionStore: SessionStore,
  onRowMounted?: (mount: TranscriptRowProps) => void,
  renderRowBody?: (mount: TranscriptRowProps) => React.JSX.Element,
  options: {
    readonly messageAnchorCursor?: string;
    readonly readTranscriptPage?: TranscriptPageRead;
    readonly drawsBody?: (row: TranscriptEventRow) => boolean;
    readonly fixture?: FixtureBridge;
  } = {},
): HTMLElement {
  const fixture = options.fixture ?? createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <TranscriptFeed
          sessionStore={sessionStore}
          rowRenderer={{
            render: (mount) => {
              onRowMounted?.(mount);
              return renderRowBody === undefined ? (
                <p>{mount.row.summary}</p>
              ) : (
                renderRowBody(mount)
              );
            },
            drawsBody: options.drawsBody ?? (() => true),
          }}
          feedLabel="Transcript"
          messageAnchorCursor={options.messageAnchorCursor}
          readTranscriptPage={options.readTranscriptPage}
        />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  const feed = container.querySelector(".meridian-transcript-feed");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("TranscriptFeed rendered no transcript element");
  }
  return feed;
}

/**
 * A row body that presses its own disclosure through the list's retained state: the smallest thing
 * that can perform the write from inside the tree, so a feed case can check that the write comes
 * back as the density the row renderer is handed.
 */
export function RetainingRowBody(props: TranscriptRowProps): React.JSX.Element {
  const retainedRowState = useRetainedRowState();
  return (
    <button
      type="button"
      className="retaining-row"
      data-density={props.density}
      onClick={() => {
        retainedRowState.setRetainedState(props.row.id, {
          density: props.density === "expanded" ? "collapsed" : "expanded",
          innerScrollTopPx: 0,
        });
      }}
    >
      {props.row.summary}
    </button>
  );
}

/** A row body naming its row by id, so a case can tell which rows the window mounted. */
export function RowIdBody(props: TranscriptRowProps): React.JSX.Element {
  return <p data-row-id={props.row.id}>{props.row.summary}</p>;
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
    owner: TRANSCRIPT_OWNER,
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
