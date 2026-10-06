// What one read puts in the mount list, and a row's way out to the diff pane. The list is drawn
// from the real reader over scripted daemon calls; a hand-built reading would pin a shape the
// reader could stop producing.

import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import {
  HEALTHY_WORKSPACE_ID,
  SESSION_ID,
  disposeTrackedReaders,
  openReader,
  sessionOperations,
  settle,
} from "../repo-mounts.test-support.js";
import { type OpenDiffSubject } from "./OpenDiffControl.js";
import { MountList } from "./MountList.js";

const MOUNT_CARD_SELECTOR = ".meridian-mount-card";

afterEach(disposeTrackedReaders);

/** The list over one settled read of the three scripted mounts. */
async function renderReadList(
  onOpenDiff: (subject: OpenDiffSubject) => void = () => undefined,
): Promise<HTMLElement> {
  const clock = new ManualClock();
  const { bridge } = bridgeOnClock("repos", clock);
  const operations = sessionOperations();
  const reader = openReader(operations, clock);
  reader.start();
  await settle(clock, reader);
  const { container } = render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <MountList
        reading={reader.snapshot}
        bridge={bridge}
        sessionStore={new SessionStore({ sessionId: SESSION_ID })}
        operations={operations}
        onCopy={() => undefined}
        onRequestRead={() => undefined}
        onOpenDiff={onOpenDiff}
      />
    </LiveAnnouncerProvider>,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
  return container;
}

describe("MountList — the mounts the read found", () => {
  it("draws a card per mount, each carrying its own health verdict", async () => {
    const container = await renderReadList();

    // One card of each verdict, the whole of `RepoMountHealth.status`.
    const [healthy, unreachable, drifted] = [...container.querySelectorAll(MOUNT_CARD_SELECTOR)];
    expect(container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(3);
    expect(within(healthy as HTMLElement).getByText("healthy")).toBeDefined();
    expect(within(unreachable as HTMLElement).getByText("unreachable")).toBeDefined();
    expect(within(drifted as HTMLElement).getByText("identity_mismatch")).toBeDefined();
    // Each card names its root, so the three are three mounts rather than one drawn thrice.
    const labels = [healthy, unreachable, drifted].map((card) => card?.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(3);
  });

  it("hands a workspace row's own subject out, from under its own mount only", async () => {
    const onOpenDiff = vi.fn();
    const container = await renderReadList(onOpenDiff);

    // `getByLabelText` throws on a second match, so a workspace drawn under every mount fails.
    fireEvent.click(
      within(container).getByLabelText(`Open the changes of workspace ${HEALTHY_WORKSPACE_ID}`),
    );
    expect(onOpenDiff).toHaveBeenCalledWith({ kind: "workspace", id: HEALTHY_WORKSPACE_ID });
  });
});
