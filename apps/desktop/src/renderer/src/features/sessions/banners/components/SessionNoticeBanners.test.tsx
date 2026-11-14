// The notice banners as the session screen draws them from its store: a notice the stream admitted
// stands after the transcript window lets its row go, `Restart` asks the daemon once however often
// it is pressed while out, and × puts a banner away without a daemon call, held on the open
// session's entry so it stays away when the screen is mounted again. A lost folder's banner
// re-attaches a folder holding another repository, naming what refuses it, and attaches the folder
// picked in place of one holding none, saying in place why an attach was refused.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  bridgeOnClock,
  withDaemonCall,
  withDaemonSubscribe,
  type RecordedDaemonCall,
} from "#test/helpers/fixture/bridge.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { FilePathRef, PickedFolder, ServedDaemonCall } from "#shared/preload-api.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { agentEntry, agentListAcknowledgment } from "#renderer/store/agents/list.test-support.js";
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
  // The banners reach only the daemon's calls and the transport's reconnects.
  const bridge = {
    transportReconnect: { subscribe: () => () => undefined },
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

const LOST_MOUNT_ID = "019b7b30-0280-7c3d-8110-cca0117a0171";
const HOLDING_MOUNT_ID = "019b7b30-0280-7c3d-8110-cca0117a0172";
const RUNNING_SESSION_ID = "019b7b30-0280-7c3d-8110-cca0117a0173";
const RUNNING_AGENT_ID = "019b7b30-0280-7c3d-8110-cca0117a0174";
const LOST_FOLDER = "/Users/me/work/app";
const PICKED_FOLDER_REF = "file-ref-picked-folder" as FilePathRef;

/** A mount as `repoMount.read` serves it, at `localPath` and under the project named, if any. */
function mountRead(id: string, localPath: string, displayName?: string): unknown {
  return {
    id,
    machineId: "019b7b30-0280-7c3d-8110-cca0117a0175",
    localPath,
    canonicalRoot: localPath,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
    attachedAt: "2026-01-01T09:05:00.200Z",
    origin: {
      kind: "attached",
      repoMountId: id,
      projectId: "019b7b30-0280-7c3d-8110-cca0117a0176",
    },
    ...(displayName === undefined ? {} : { displayName }),
    usedBy: [],
  };
}

/** A daemon refusal in the wire's error shape, carrying its named members. */
function daemonRefusal(type: string, fields: Readonly<Record<string, unknown>>): unknown {
  return { code: -31000, message: `${type} refused`, data: { type, category: "conflict", fields } };
}

interface LostFolderUnderTest {
  readonly daemonCalls: readonly RecordedDaemonCall[];
  readonly agentListsOpened: unknown[];
}

// The session's folder lost with `health`, its read naming the folder, every other call answered
// by `answer`, the running session's agent list naming its agent, and the picker as `picked`.
function renderLostFolder(
  health: Readonly<Record<string, unknown>>,
  answer: (call: RecordedDaemonCall) => unknown,
  picked: PickedFolder | null = null,
): LostFolderUnderTest {
  const agentListsOpened: unknown[] = [];
  const { calls, bridge: answering } = withDaemonCall(
    bridgeOnClock("lost-folder-banner").bridge,
    (call) =>
      call.method === "repoMount.read" &&
      (call.params as { repoMountId: string }).repoMountId === LOST_MOUNT_ID
        ? Promise.resolve(mountRead(LOST_MOUNT_ID, LOST_FOLDER))
        : Promise.resolve().then(() => answer(call)),
  );
  const subscribing = withDaemonSubscribe(answering, (_passThrough, deliver, request) => {
    agentListsOpened.push(request);
    deliver(agentListAcknowledgment([agentEntry(RUNNING_AGENT_ID, "Reviewer")]));
    return () => undefined;
  });
  const bridge: PlatformBridge = {
    ...subscribing,
    native: {
      ...subscribing.native,
      showOpenDialog: (() => Promise.resolve(picked)) as PlatformBridge["native"]["showOpenDialog"],
    },
  };
  const entry = new OpenSessionEntry(SESSION_ID, {
    read: () => Promise.resolve(undefined),
    openingPageLimit: () => 50,
    offScreenRowLimit: () => 50,
  });
  entry.store.initialize({ shape: "project", cursor: 0, entities: [] });
  entry.store.applyBatch([
    eventOfKind(SESSION_ID, "repoMount.health.changed", 1, {
      repoMountId: LOST_MOUNT_ID,
      health: { checkedAt: "2026-01-01T09:00:00Z", ...health },
    }),
  ]);
  render(
    <LiveAnnouncerProvider>
      <ServedProviderSections>
        <SessionNoticeBanners
          bridge={bridge}
          sessionId={SESSION_ID}
          sessionStore={entry.store}
          dismissed={entry.dismissedNotices}
          onFolderReadRefused={() => undefined}
        />
      </ServedProviderSections>
    </LiveAnnouncerProvider>,
  );
  return { daemonCalls: calls, agentListsOpened };
}

const MISMATCHED_REPOSITORY = { status: "identityMismatch", isRepository: true };

// The line a refused press draws beside its word, or `null` while none stands.
function refusalLine(): Element | null {
  return document.querySelector(".meridian-session-screen__banner-refusal");
}

// Press the banner's act once the folder's read has named it, and wait for the press to settle.
async function press(label: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: label }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the lost folder's banner", () => {
  it("re-attaches a folder holding another repository, opens another holding none", async () => {
    renderLostFolder(MISMATCHED_REPOSITORY, () => ({}));
    expect(await screen.findByRole("button", { name: "Re-attach" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open folder…" })).toBeNull();
    cleanup();

    renderLostFolder({ status: "identityMismatch", isRepository: false }, () => ({}));
    expect(await screen.findByRole("button", { name: "Open folder…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-attach" })).toBeNull();
    cleanup();

    renderLostFolder({ status: "unreachable" }, () => ({}));
    expect(await screen.findByText(`${LOST_FOLDER} can't be reached`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open folder…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-attach" })).toBeNull();
  });

  it("sends the re-attach for the lost mount and draws nothing once it is served", async () => {
    const banner = renderLostFolder(MISMATCHED_REPOSITORY, () => ({
      repoMountId: "019b7b30-0280-7c3d-8110-cca0117a0177",
    }));
    await press("Re-attach");

    expect(banner.daemonCalls.slice(1)).toStrictEqual([
      { method: "repoMount.reattach", params: { repoMountId: LOST_MOUNT_ID } },
    ]);
    expect(refusalLine()).toBeNull();
  });

  it("names the project whose mount already holds the repository, or a chat", async () => {
    const refusedBy = (displayName?: string) => (call: RecordedDaemonCall) => {
      if (call.method === "repoMount.read") {
        return mountRead(HOLDING_MOUNT_ID, "/Users/me/work/other", displayName);
      }
      throw daemonRefusal("repoMount.alreadyAttached", {
        conflictingRepoMountId: HOLDING_MOUNT_ID,
        conflictingProjectId: displayName === undefined ? null : "project-beacon",
      });
    };

    renderLostFolder(MISMATCHED_REPOSITORY, refusedBy("beacon"));
    await press("Re-attach");
    expect(
      await screen.findByText(`Couldn't re-attach · ${LOST_FOLDER} is already attached to beacon`),
    ).toBeTruthy();
    cleanup();

    renderLostFolder(MISMATCHED_REPOSITORY, refusedBy());
    await press("Re-attach");
    expect(
      await screen.findByText(`Couldn't re-attach · ${LOST_FOLDER} is already attached to a chat`),
    ).toBeTruthy();
  });

  it("names the agent whose run stands in the way, from its own session's agents", async () => {
    const banner = renderLostFolder(MISMATCHED_REPOSITORY, () => {
      throw daemonRefusal("repoMount.reattachConflict", {
        runningSessionId: RUNNING_SESSION_ID,
        runningHolder: { kind: "agent", agentId: RUNNING_AGENT_ID },
      });
    });
    await press("Re-attach");

    expect(await screen.findByText("Couldn't re-attach · Reviewer is running")).toBeTruthy();
    expect(banner.agentListsOpened).toStrictEqual([{ sessionId: RUNNING_SESSION_ID }]);
  });

  it("attaches the folder picked under Open folder… by its token, and nothing on cancel", async () => {
    const opened = renderLostFolder(
      { status: "identityMismatch", isRepository: false },
      () => ({
        repoMountId: "019b7b30-0280-7c3d-8110-cca0117a0178",
        state: "attached",
        vcsType: "git",
        canonicalRoot: "/Users/me/work/picked",
      }),
      { ref: PICKED_FOLDER_REF, name: "picked" },
    );
    await press("Open folder…");
    expect(opened.daemonCalls.slice(1).map((call) => call.params)).toStrictEqual([
      { localPath: PICKED_FOLDER_REF },
    ]);
    expect(opened.daemonCalls[1]?.method).toBe("repoMount.attach");
    expect(refusalLine()).toBeNull();
    cleanup();

    const canceled = renderLostFolder(
      { status: "identityMismatch", isRepository: false },
      () => ({}),
    );
    await press("Open folder…");
    expect(canceled.daemonCalls.map((call) => call.method)).toStrictEqual(["repoMount.read"]);
  });

  it("says in place that the folder picked under Open folder… is no git repository", async () => {
    renderLostFolder(
      { status: "identityMismatch", isRepository: false },
      () => {
        throw daemonRefusal("repoMount.rootResolutionFailed", { reason: "notARepository" });
      },
      { ref: PICKED_FOLDER_REF, name: "picked" },
    );
    await press("Open folder…");

    expect(refusalLine()?.textContent).toBe("Couldn't attach · not a git repository");
  });
});
