import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStubBridge, type ClipboardContent } from "#shared/preload-api.js";
import { TRANSIENT_STATUS_DURATION_MS } from "#renderer/lib/transient-status.js";
import { createLiveBridge } from "#renderer/services/platform/live-bridge.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import {
  FIXTURE_APP_META,
  FIXTURE_WINDOW_ID,
} from "#renderer/services/platform/platform-bridge.fixture.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { useClipboardCopy } from "./useClipboardCopy.js";

const MESSAGE_TEXT = "Rename `readFrozenRecord` and keep its callers.\n\nTwo files.";

function bridgeCopyingWith(
  copyToClipboard: (content: ClipboardContent) => Promise<void>,
): PlatformBridge {
  const bridge = createLiveBridge(createStubBridge({ ...FIXTURE_APP_META }, FIXTURE_WINDOW_ID));
  return {
    ...bridge,
    native: { ...bridge.native, copyToClipboard },
  };
}

function MessageCopy(): React.JSX.Element {
  return <CopyButton label="Copy" clipboardCopy={useClipboardCopy({ text: MESSAGE_TEXT })} />;
}

async function pressCopy(bridge: PlatformBridge): Promise<void> {
  render(
    <PlatformBridgeProvider bridge={bridge}>
      <MessageCopy />
    </PlatformBridgeProvider>,
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
    const copied: ClipboardContent[] = [];
    await pressCopy(
      bridgeCopyingWith(async (content) => {
        copied.push(content);
      }),
    );

    expect(copied).toStrictEqual([{ text: MESSAGE_TEXT }]);
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
});
