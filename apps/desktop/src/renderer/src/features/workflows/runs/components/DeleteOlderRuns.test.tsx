// Escape closes `Delete runs older than…` as its `Cancel` does, before anything behind it hears the
// key: the choice takes focus as it opens, so the next key reaches it, and a screen's own Escape
// (closing a panel, leaving a run) never fires on the same press. Nothing is deleted.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { DeleteOlderRuns } from "./DeleteOlderRuns.js";

afterEach(cleanup);

describe("`Delete runs older than…` on Escape", () => {
  it("closes before the screen behind it hears the key, and deletes nothing", () => {
    const { bridge, engine, calls } = bridgeAnswering(async (_call, passThrough) => passThrough());
    const Host = bridgeWrapper(bridge, engine.clock);
    const screenEscape = vi.fn();
    render(
      <Host>
        <div onKeyDown={screenEscape}>
          <DeleteOlderRuns bridge={bridge} />
        </div>
      </Host>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete runs older than…" }));
    const choice = screen.getByRole("group", { name: "Delete runs older than…" });
    expect(choice.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? choice, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Delete runs older than…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete runs older than…" })).toBeTruthy();

    expect(screenEscape).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.method === "workflow.runsDelete")).toStrictEqual([]);
  });
});
