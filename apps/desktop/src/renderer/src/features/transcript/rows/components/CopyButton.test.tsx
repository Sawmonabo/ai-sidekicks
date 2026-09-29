// A message's Copy control: what a press puts on the clipboard, and the in-place
// outcome that clears after the one transient-status duration.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStubBridge } from "@shared/preload-api.js";
import { TRANSIENT_STATUS_DURATION_MS } from "@renderer/lib/transient-status.js";
import { createLiveBridge } from "@renderer/services/platform/live-bridge.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { FIXTURE_APP_META } from "@renderer/services/platform/platform-bridge.fixture.js";
import { DesktopBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { CopyButton } from "./CopyButton.js";

const MESSAGE_TEXT = "Rename `readFrozenRecord` and keep its callers.\n\nTwo files.";

function bridgeCopyingWith(copyToClipboard: (text: string) => Promise<void>): ConsoleBridge {
  const bridge = createLiveBridge(createStubBridge({ ...FIXTURE_APP_META }));
  return {
    ...bridge,
    desktopBridge: {
      ...bridge.desktopBridge,
      native: { ...bridge.desktopBridge.native, copyToClipboard },
    },
  };
}

async function pressCopy(bridge: ConsoleBridge): Promise<void> {
  render(
    <DesktopBridgeProvider bridge={bridge}>
      <CopyButton text={MESSAGE_TEXT} />
    </DesktopBridgeProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a message's Copy control", () => {
  it("puts the text on the clipboard verbatim, reads Copied, then returns to rest", async () => {
    const copied: string[] = [];
    await pressCopy(
      bridgeCopyingWith(async (text) => {
        copied.push(text);
      }),
    );

    expect(copied).toStrictEqual([MESSAGE_TEXT]);
    expect(screen.getByRole("button").textContent).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_STATUS_DURATION_MS - 1);
    });
    expect(screen.getByRole("button").textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button").textContent).toBe("Copy");
  });

  it("reads Could not copy when the host rejects", async () => {
    await pressCopy(bridgeCopyingWith(() => Promise.reject(new Error("clipboard refused"))));

    expect(screen.getByRole("button").textContent).toBe("Could not copy");
  });

  it("reads Could not copy when the host throws before answering", async () => {
    // The shipped stub bridge throws synchronously rather than rejecting.
    await pressCopy(createLiveBridge(createStubBridge({ ...FIXTURE_APP_META })));

    expect(screen.getByRole("button").textContent).toBe("Could not copy");
  });
});
