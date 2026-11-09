// The notice banners as the session screen draws them from its store: a notice the stream admitted
// stands after the transcript window lets its row go, `Restart` asks the daemon once however often
// it is pressed while out, and × puts a banner away without a daemon call, held on the open
// session's entry so it stays away when the screen is mounted again.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { ServedDaemonCall } from "#shared/preload-api.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { ServedProviderSections } from "#renderer/store/providers/ServedProviderSections.test-support.js";
import { OpenSessionEntry } from "#renderer/store/session/open/entry.js";

import { SessionNoticeBanners } from "./SessionNoticeBanners.js";

const SESSION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CONFIG_FILE = "/Users/me/.codex/config.toml";

interface BannersUnderTest {
  readonly daemonCalls: string[];
  readonly answerRestart: () => void;
  /** Unmounts the banners and mounts them again on the same open session. */
  readonly remount: () => void;
}

// The store holds the notices as the stream admitted them, then lets every row but the newest go,
// so a banner can stand only on what the store keeps standing.
function renderBanners(): BannersUnderTest {
  const daemonCalls: string[] = [];
  let answerRestart = (): void => undefined;
  // The banners reach only the daemon's calls.
  const bridge = {
    daemon: {
      call: (method: string) => {
        daemonCalls.push(method);
        return new Promise<ServedDaemonCall<unknown>>((resolve) => {
          answerRestart = () => {
            resolve({ value: {} });
          };
        });
      },
    },
  } as unknown as PlatformBridge;
  const entry = new OpenSessionEntry(SESSION_ID, {
    read: () => Promise.resolve(undefined),
    openingPageLimit: () => 50,
    offScreenRowLimit: () => 50,
  });
  const store = entry.store;
  store.initialize({ shape: "project", cursor: 0, entities: [] });
  store.applyBatch([
    eventOfKind(SESSION_ID, "session.notice.posted", 1, {
      sessionId: SESSION_ID,
      kind: "providerCrashLoop",
      provider: "codex",
      exitCode: 137,
    }),
    eventOfKind(SESSION_ID, "session.notice.posted", 2, {
      sessionId: SESSION_ID,
      kind: "settingsIgnored",
      provider: "codex",
      file: CONFIG_FILE,
      line: 4,
    }),
    eventOfKind(SESSION_ID, "agent.run.queued", 3),
  ]);
  store.releaseBeyondNewest(1);
  const tree = () => (
    <LiveAnnouncerProvider>
      <ServedProviderSections>
        <SessionNoticeBanners
          bridge={bridge}
          sessionId={SESSION_ID}
          sessionStore={store}
          dismissed={entry.dismissedNotices}
          onFolderReadRefused={() => undefined}
        />
      </ServedProviderSections>
    </LiveAnnouncerProvider>
  );
  const rendered = render(tree());
  return {
    daemonCalls,
    answerRestart: () => {
      answerRestart();
    },
    remount: () => {
      rendered.unmount();
      render(tree());
    },
  };
}

describe("the session's notice banners", () => {
  it("restarts the provider once however often Restart is pressed while it is out", async () => {
    const banners = renderBanners();
    expect(screen.getByText("Codex ended unexpectedly")).toBeTruthy();

    const restart = screen.getByRole("button", { name: "Restart" });
    fireEvent.click(restart);
    fireEvent.click(restart);
    await act(async () => {
      banners.answerRestart();
      await Promise.resolve();
    });

    expect(banners.daemonCalls).toStrictEqual(["session.restart"]);
  });

  it("puts a banner away with its ×, asking nothing, and keeps it away on coming back", () => {
    const banners = renderBanners();

    const [firstDismiss] = screen.getAllByRole("button", { name: "Dismiss this notice" });
    fireEvent.click(firstDismiss as HTMLElement);
    banners.remount();

    expect(screen.queryByText("Codex ended unexpectedly")).toBeNull();
    expect(screen.getByText("Codex ignored its config file")).toBeTruthy();
    expect(banners.daemonCalls).toStrictEqual([]);
  });
});
