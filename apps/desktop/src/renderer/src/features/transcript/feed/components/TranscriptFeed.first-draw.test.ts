// When the feed first shows its rows: once the session's first read has landed and the faces its
// first rows draw in have settled. Until then the rows are laid out hidden, `Loading…` stands past
// the loading line's delay, or nothing while the line under the session header says the read
// failed, and find walks none of them. The test DOM has no font set, so a case that waits on the
// faces hands the document one whose loads it settles.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOADING_NOTICE_DELAY_MS } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { TYPEFACE_WAIT_MS } from "../../hooks/useTypefacesSettled.js";
import { SESSION_ID, openSessionStoreWithGeneralLog } from "../../logs.test-support.js";
import { withLaidOutViewport } from "../../viewport/controller.test-support.js";
import {
  RowIdBody,
  SHORT_LOG_EVENT_COUNT,
  contributeTranscriptCommands,
  dispatchCommand,
  renderFeed,
  scrollContainerOf,
  withdrawTranscriptCommands,
} from "./TranscriptFeed.test-support.js";

let detachForwarder: (() => void) | undefined;

// A command acts in the window used last; the test's document stands in for it.
beforeEach(() => publishCommandWindow(() => document));

afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  detachForwarder?.();
  detachForwarder = undefined;
  withdrawTranscriptCommands();
  vi.restoreAllMocks();
});

/** A font set whose `ready` settles when the case says, at the status it starts in. */
function handDocumentFonts(status: FontFaceSetLoadStatus): () => void {
  let settle = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  if (status === "loaded") {
    settle();
  }
  Object.defineProperty(document, "fonts", { configurable: true, value: { status, ready } });
  return () => {
    settle();
  };
}

function advance(fixture: FixtureBridge, milliseconds: number): void {
  act(() => {
    fixture.scenarioEngine.advance(milliseconds);
  });
}

function isShown(feed: HTMLElement): boolean {
  const viewport = feed.querySelector(".meridian-transcript-viewport");
  return viewport !== null && !viewport.classList.contains("meridian-transcript-viewport--hidden");
}

/** The rows a person can see: none while the viewport is hidden. */
function shownRowCount(feed: HTMLElement): number {
  return isShown(feed) ? feed.querySelectorAll("[data-row-id]").length : 0;
}

function saysLoading(feed: HTMLElement): boolean {
  return feed.textContent.includes("Loading…");
}

describe("the transcript feed — its first draw", () => {
  it("says nothing before the loading line's delay, then Loading…, through both waits", async () => {
    withLaidOutViewport();
    // The first read in flight, the faces already in.
    const firstReadFixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const unreadStore = new SessionStore({ sessionId: SESSION_ID });
    const unreadFeed = renderFeed(unreadStore, undefined, RowIdBody, { fixture: firstReadFixture });
    advance(firstReadFixture, LOADING_NOTICE_DELAY_MS - 1);
    const saidBeforeTheDelay = saysLoading(unreadFeed);
    const shownBeforeTheRead = isShown(unreadFeed);
    advance(firstReadFixture, 1);
    const saidAtTheDelay = saysLoading(unreadFeed);
    act(() => {
      unreadStore.initialize({ cursor: -1, entities: [] });
    });

    // The first read landed, the faces still loading.
    const settleFaces = handDocumentFonts("loading");
    const facesFixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const facesFeed = renderFeed(
      openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT),
      undefined,
      RowIdBody,
      { fixture: facesFixture },
    );
    advance(facesFixture, LOADING_NOTICE_DELAY_MS - 1);
    const facesSaidBeforeTheDelay = saysLoading(facesFeed);
    const rowsBeforeTheFaces = shownRowCount(facesFeed);
    advance(facesFixture, 1);
    const facesSaidAtTheDelay = saysLoading(facesFeed);
    await act(async () => {
      settleFaces();
      await Promise.resolve();
    });

    expect([saidBeforeTheDelay, saidAtTheDelay, saysLoading(unreadFeed)]).toStrictEqual([
      false,
      true,
      false,
    ]);
    expect([shownBeforeTheRead, isShown(unreadFeed)]).toStrictEqual([false, true]);
    expect([facesSaidBeforeTheDelay, facesSaidAtTheDelay]).toStrictEqual([false, true]);
    expect(rowsBeforeTheFaces).toBe(0);
    expect(saysLoading(facesFeed)).toBe(false);
    expect(shownRowCount(facesFeed)).toBeGreaterThan(0);
  });

  it("shows an already-read session with its rows, opened and switched back to", () => {
    withLaidOutViewport();
    handDocumentFonts("loaded");
    const sessionStore = openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT);
    // Every commit, as the mount makes it: none may show the viewport without its rows.
    const commits: { readonly isShown: boolean; readonly rowCount: number }[] = [];
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const mount = (): HTMLElement =>
      renderFeed(sessionStore, undefined, RowIdBody, {
        fixture,
        onCommit: (feed) => {
          commits.push({
            isShown: isShown(feed),
            rowCount: feed.querySelectorAll("[data-row-id]").length,
          });
        },
      });

    const openedRowCount = shownRowCount(mount());
    cleanup();
    // The mount settles inside its own render, with no clock moved and no promise awaited.
    const switchedBackFeed = mount();
    const switchedBackRowCount = shownRowCount(switchedBackFeed);
    advance(fixture, LOADING_NOTICE_DELAY_MS);

    expect(openedRowCount).toBeGreaterThan(0);
    expect(switchedBackRowCount).toBe(openedRowCount);
    expect(commits.filter((commit) => commit.isShown && commit.rowCount === 0)).toEqual([]);
    expect(saysLoading(switchedBackFeed)).toBe(false);
  });

  it("shows the rows in the fallback once the faces run past their wait, and records it", () => {
    withLaidOutViewport();
    handDocumentFonts("loading");
    const records: string[] = [];
    detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      records.push(jsonLines);
    });
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT),
      undefined,
      RowIdBody,
      { fixture },
    );
    advance(fixture, TYPEFACE_WAIT_MS - 1);
    const rowsBeforeTheWait = shownRowCount(feed);
    advance(fixture, 1);
    windowDiagnosticCapture.flush();

    expect(rowsBeforeTheWait).toBe(0);
    expect(shownRowCount(feed)).toBeGreaterThan(0);
    expect(records.join("\n")).toContain("typefaces-still-loading");
  });

  it("finds nothing among the hidden rows, and the rows once they are shown", async () => {
    withLaidOutViewport();
    contributeTranscriptCommands();
    const settleFaces = handDocumentFonts("loading");
    const feed = renderFeed(openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT));
    dispatchCommand("transcript.find");
    const findField =
      feed.querySelector<HTMLInputElement>(".meridian-find__input") ??
      expect.fail("the find field opened");
    fireEvent.change(findField, { target: { value: "user" } });
    const countWhileHidden = feed.querySelector(".meridian-find")?.textContent ?? "";
    await act(async () => {
      settleFaces();
      await Promise.resolve();
    });

    expect(countWhileHidden).toContain("No matches");
    expect(feed.querySelector(".meridian-find")?.textContent ?? "").not.toContain("No matches");
  });

  it("puts focus on the log once shown when find closes while it is hidden, unless it moved", async () => {
    withLaidOutViewport();
    contributeTranscriptCommands();
    /** Opens find on a feed whose faces are loading, closes it, and lands the faces. */
    const closeFindWhileHidden = async (moveFocus: () => void): Promise<HTMLElement> => {
      const settleFaces = handDocumentFonts("loading");
      const feed = renderFeed(openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT));
      dispatchCommand("transcript.find");
      const findField =
        feed.querySelector<HTMLInputElement>(".meridian-find__input") ??
        expect.fail("the find field opened");
      fireEvent.keyDown(findField, { key: "Escape" });
      moveFocus();
      await act(async () => {
        settleFaces();
        await Promise.resolve();
      });
      return feed;
    };

    const keptFeed = await closeFindWhileHidden(() => undefined);
    const focusedWhenKept = document.activeElement === scrollContainerOf(keptFeed);
    cleanup();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await closeFindWhileHidden(() => {
      elsewhere.focus();
    });
    const focusedWhenMoved = document.activeElement;
    elsewhere.remove();

    expect(focusedWhenKept).toBe(true);
    expect(focusedWhenMoved).toBe(elsewhere);
  });

  it("says no Loading… while the line under the session header says the read failed", () => {
    withLaidOutViewport();
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.markReadFailed();
    const feed = renderFeed(sessionStore, undefined, RowIdBody, { fixture });
    advance(fixture, LOADING_NOTICE_DELAY_MS);

    expect(saysLoading(feed)).toBe(false);
    expect(isShown(feed)).toBe(false);
  });
});
