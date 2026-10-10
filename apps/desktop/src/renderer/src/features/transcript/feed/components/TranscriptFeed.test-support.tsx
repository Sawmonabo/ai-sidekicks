// The shared scaffolding for the transcript-feed cases: a mount under a bridge, the reader's own
// scroll, the controller the mount bound, and a way to press a contributed palette row. The logs
// live in `features/transcript/logs.test-support.ts` because a store builder needs no DOM; the
// laid-out box a virtualizer range needs is `withLaidOutViewport` in
// `features/transcript/viewport/controller.test-support.ts`.

import { act, fireEvent, render } from "@testing-library/react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { useRowToggle } from "../../rows/hooks/useRowToggle.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { commandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { registerTranscriptCommands } from "../../contributions/commands.js";
import { TRANSCRIPT_OWNER } from "../../contributions/screens.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptRowProps } from "../../rows/renderer.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { ViewportController } from "../../viewport/controller.js";
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
              return renderRowBody === undefined ? <p>{mount.row.type}</p> : renderRowBody(mount);
            },
            drawsBody: options.drawsBody ?? (() => true),
            prepareRow: () => undefined,
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
 * A row body that folds itself through the feed's row toggle: the smallest thing that can press a
 * call's chevron from inside the tree, so a feed case can check that the press comes back as the
 * density the row renderer is handed.
 */
export function CallFoldingRowBody(props: TranscriptRowProps): React.JSX.Element {
  const { toggleCallFold } = useRowToggle();
  return (
    <button
      type="button"
      className="call-folding-row"
      data-row-id={props.row.id}
      data-density={props.density}
      onClick={(event) => {
        toggleCallFold(props.row.id, event.currentTarget);
      }}
    >
      {props.row.type}
    </button>
  );
}

/** The feed's scroll container, refusing rather than answering null. */
export function scrollContainerOf(feed: HTMLElement): HTMLElement {
  const scrollContainer = feed.querySelector(".meridian-transcript-viewport__scroll-container");
  if (!(scrollContainer instanceof HTMLElement)) {
    throw new Error("the feed rendered no scroll container");
  }
  return scrollContainer;
}

/**
 * The reader's own scroll: their wheel, which turns no line here, then the box moves and says so,
 * as the platform does after a wheel. `inputAtMs`, where given, is both events' own time stamp.
 */
export function readerScrollsTo(
  scrollContainer: HTMLElement,
  scrollTopPx: number,
  inputAtMs?: number,
): void {
  const wheel = new WheelEvent("wheel", { deltaY: 0, bubbles: true });
  const scroll = new UIEvent("scroll");
  if (inputAtMs !== undefined) {
    Object.defineProperty(wheel, "timeStamp", { value: inputAtMs });
    Object.defineProperty(scroll, "timeStamp", { value: inputAtMs });
  }
  fireEvent(scrollContainer, wheel);
  scrollContainer.scrollTop = scrollTopPx;
  fireEvent(scrollContainer, scroll);
}

/**
 * The controller the mounted feed bound its virtualizer to, read off a spy on
 * `ViewportController.prototype.bindVirtualizer` set before the mount.
 */
export function boundController(bindings: {
  readonly mock: { readonly contexts: readonly unknown[] };
}): ViewportController {
  const controller = bindings.mock.contexts.at(-1);
  if (!(controller instanceof ViewportController)) {
    throw new Error("the feed bound no virtualizer to a viewport controller");
  }
  return controller;
}

/** A row body naming its row by id, so a case can tell which rows the window mounted. */
export function RowIdBody(props: TranscriptRowProps): React.JSX.Element {
  return <p data-row-id={props.row.id}>{props.row.type}</p>;
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
    .commandsFor({ sessionActive: true, transcriptHoldsRunGroup: true })
    .find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`no command named ${commandId} is contributed to this window`);
  }
  act(() => {
    void command.run();
  });
}
