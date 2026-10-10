import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStubBridge, type ClipboardContent } from "#shared/preload-api.js";
import { TRANSIENT_STATUS_DURATION_MS } from "#renderer/lib/transient-status.js";
import { createLiveBridge } from "#renderer/services/platform/live-bridge.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { FIXTURE_APP_META, FIXTURE_WINDOW_ID } from "#renderer/services/platform/bridge.fixture.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { useClipboardCopy } from "./useClipboardCopy.js";

const MESSAGE_TEXT = "Rename `readFrozenRecord` and keep its callers.\n\nTwo files.";

/**
 * A bridge writing each copy through `copyToClipboard`, a late one only while `isUnchanged`
 * answers that no newer copy took the clipboard.
 */
function bridgeCopyingWith(
  copyToClipboard: (content: ClipboardContent) => Promise<void>,
  isUnchanged = () => true,
): PlatformBridge {
  const bridge = createLiveBridge(createStubBridge({ ...FIXTURE_APP_META }, FIXTURE_WINDOW_ID));
  return {
    ...bridge,
    native: {
      ...bridge.native,
      copyToClipboard,
      takeClipboardSnapshot: async () => ({ digest: "held" }),
      copyToClipboardUnlessChanged: async (content) => {
        if (!isUnchanged()) {
          return false;
        }
        await copyToClipboard(content);
        return true;
      },
    },
  };
}

function MessageCopy(props: {
  readonly content: Parameters<typeof useClipboardCopy>[0];
}): React.JSX.Element {
  return <CopyButton label="Copy" clipboardCopy={useClipboardCopy(props.content)} />;
}

async function pressCopy(
  bridge: PlatformBridge,
  content: Parameters<typeof useClipboardCopy>[0] = { text: MESSAGE_TEXT },
): Promise<void> {
  render(
    <PlatformBridgeProvider bridge={bridge}>
      <MessageCopy content={content} />
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

describe("a Copy control whose content is built after the press", () => {
  it("writes content once built, and reads Could not copy when it cannot be built", async () => {
    const copied: ClipboardContent[] = [];
    const bridge = bridgeCopyingWith(async (content) => {
      copied.push(content);
    });
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    await pressCopy(bridge, async () => ({ png }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copied).toStrictEqual([{ png }]);
    expect(screen.getByRole("button").textContent).toBe("Copied");

    cleanup();
    await pressCopy(bridge, () => Promise.reject(new Error("the picture did not decode")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copied).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toBe("Could not copy");
  });

  it("writes nothing and says nothing once a newer copy took the clipboard", async () => {
    const copied: ClipboardContent[] = [];
    const bridge = bridgeCopyingWith(
      async (content) => {
        copied.push(content);
      },
      () => false,
    );
    await pressCopy(bridge, async () => ({ png: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copied).toStrictEqual([]);
    expect(screen.getByRole("button").textContent).toBe("Copy");
  });
});
