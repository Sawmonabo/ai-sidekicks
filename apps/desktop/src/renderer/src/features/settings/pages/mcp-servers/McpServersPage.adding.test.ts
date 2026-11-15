// The MCP servers page's `Add a server`: each opening of the form settles only its own send, in
// place, whatever the list holds when the answer lands, and one press makes one upsert.

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  McpServerInventoryEntry,
  McpServerMutationResponse,
} from "@ai-sidekicks/contracts/mcp/server";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { refuse, RefusalError } from "#renderer/lib/refusal/contract.js";
import {
  FILESYSTEM,
  operationsServing,
  PARTIAL_APPLICATION,
  renderSettledMcpPage,
} from "./McpServersPage.test-support.js";

afterEach(() => {
  cleanup();
});

/** The line a server the service took stands under `Add a server` with. */
const SERVER_SENT_LINE =
  "The server was sent to the background service. Every value typed here was cleared on submit.";

/** Press the button named `name`. */
function press(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Fill the open form's name and command, then send it. */
function sendServer(name: string, command: string): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
    target: { value: command },
  });
  press("Add the server");
}

describe("McpServersPage — Add a server", () => {
  it("settles each send only in the form that sent it, wherever the list stands when it lands", async () => {
    let served: readonly McpServerInventoryEntry[] = [];
    let announceChange = (): void => undefined;
    const heldSends: {
      readonly resolve: (response: McpServerMutationResponse) => void;
      readonly reject: (reason: unknown) => void;
    }[] = [];
    const sendUpsert = vi.fn(
      async () =>
        await new Promise<McpServerMutationResponse>((resolve, reject) => {
          heldSends.push({ resolve, reject });
        }),
    );
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([], {
        listInventory: async () => await Promise.resolve({ servers: served, failedProviders: [] }),
        subscribeInventoryChanges: (onChange) => {
          announceChange = onChange;
          return () => undefined;
        },
        sendUpsert,
      }),
    );
    const adding = (): Element | null =>
      container.querySelector('section[aria-label="Add a server"]');
    const form = (): Element | null => container.querySelector("form.meridian-mcp__add-form");
    const sendControl = (): HTMLElement => screen.getByRole("button", { name: "Add the server" });

    // The first server on an empty list: the list read again after the answer holds a server.
    press("Add a server");
    sendServer("notes", "notes-mcp");
    served = [FILESYSTEM];
    await act(async () => {
      heldSends[0]?.resolve(PARTIAL_APPLICATION);
      await crossMacrotaskBoundary();
    });
    await settleScheduledRead(clock);
    expect(container.querySelectorAll(".meridian-mcp__entry")).toHaveLength(1);
    expect(adding()?.textContent).toContain(SERVER_SENT_LINE);
    press("Add a server");
    expect(form()).not.toBeNull();
    expect(adding()?.textContent).not.toContain(SERVER_SENT_LINE);

    // A send still on its way when its form closed, across a pushed change that empties the list.
    sendServer("drafts", "drafts-mcp");
    press("Cancel");
    served = [];
    act(() => {
      announceChange();
    });
    await settleScheduledRead(clock);
    expect(container.querySelectorAll(".meridian-mcp__entry")).toHaveLength(0);
    press("Add a server");
    expect(form()).not.toBeNull();
    // No second send goes out while the first is on its way.
    expect(sendControl()).toHaveProperty("disabled", true);

    await act(async () => {
      heldSends[1]?.reject(
        new RefusalError(refuse("mcp-test", "mcp.server.configInvalid", "The second send failed.")),
      );
      await crossMacrotaskBoundary();
    });
    expect(form()?.querySelector("[data-refusal-code]")).toBeNull();
    expect(form()?.textContent).not.toContain("The second send failed.");
    expect(sendControl()).toHaveProperty("disabled", false);
    expect(sendUpsert).toHaveBeenCalledTimes(2);
  });
});
