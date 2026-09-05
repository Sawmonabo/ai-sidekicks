// What the updates page's controls do, and what they refuse to do.
//
// The restart offered only by the finished arm, the single line every control failure
// lands on however it failed, and the automatic-update choice held for the window
// rather than for the section. What the page READS is
// `UpdatesPage.reading.test.tsx`, over the one cast in `updates-page.test-support.tsx`.
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../../core/index.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../../primitives/index.js";
import { UpdatesPage } from "./UpdatesPage.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import {
  bridgeReporting,
  pressCheckNow,
  renderSettled,
  updatesBlockOf,
} from "./updates-page.test-support.js";

describe("updates page — nothing restarts without a press", () => {
  it("offers the restart only once the download has finished", async () => {
    const { page: ready } = await renderSettled(bridgeReporting({ status: "ready" }));
    const labels = [...ready.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: a download in progress offers no restart", async () => {
    // Without this, the case above would pass over a page that always drew the
    // control — which would let a person restart into an incomplete download.
    const { page: downloading } = await renderSettled(
      bridgeReporting({ status: "downloading", percent: 99 }),
    );
    const labels = [...downloading.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).not.toContain("Restart to apply");
  });

  it("restarts only when the control is pressed", async () => {
    const requestRestart = vi.fn(() => Promise.resolve());
    const { page: container } = await renderSettled(
      bridgeReporting({ status: "ready" }, { requestRestart }),
    );
    expect(requestRestart).not.toHaveBeenCalled();
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart to apply",
    );
    await act(async () => {
      restart?.click();
      await Promise.resolve();
    });
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("renders a refused check beside the controls rather than swallowing it", async () => {
    const { page: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        { requestCheck: () => Promise.reject(new Error("the updater is disabled in this build")) },
      ),
    );
    await pressCheckNow(container);
    expect(container.textContent ?? "").toContain("the updater is disabled in this build");
  });

  it("puts the refuser's own code on screen beside its message", async () => {
    // The code used to be discarded entirely: `wireRejectionToError` puts a
    // registered daemon code on `Error.name` and this page read only `.message`, so
    // every refusal the updater namespace can raise reached a person with the one
    // part `Spec-023 §Console Design (Meridian)` rule 9 requires verbatim missing.
    const { page: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        {
          requestCheck: () =>
            Promise.reject({
              code: "update.channel_unavailable",
              message: "no feed is configured",
            }),
        },
      ),
    );
    await pressCheckNow(container);

    const refusal = container.querySelector(".meridian-refusal--inline");
    expect(refusal?.textContent ?? "").toContain("update.channel_unavailable");
    expect(refusal?.textContent ?? "").toContain("no feed is configured");
  });

  it("negative control: a code this page invented never displaces a registered one", async () => {
    // Without this, the case above would hold for a page that rendered its own
    // fallback code beside every message it happened to keep.
    const { page: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        {
          requestCheck: () =>
            Promise.reject({
              code: "update.channel_unavailable",
              message: "no feed is configured",
            }),
        },
      ),
    );
    await pressCheckNow(container);

    expect(container.textContent ?? "").not.toContain("control-failed");
  });
});

describe("updates page — a control fails onto one line, however it failed", () => {
  it("renders the refusal when the control THROWS rather than rejecting", async () => {
    // The shape that matters on the build a person runs. The shipped Tier-1 bridge
    // implements every updater method as a synchronous `throw`, while the fixture's
    // refusals arrive as rejected promises — so a handler that attached its `catch`
    // to the RETURNED promise handled the fixture and let the release build's throw
    // escape the React event handler with no line ever drawn. This case fails on
    // that shape and is the negative control for it: the sentence below is never
    // set, because the call never reaches the boundary that sets it.
    const { page: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        {
          requestCheck: () => {
            throw new Error("the updater is not built into this build");
          },
        },
      ),
    );
    await pressCheckNow(container);
    expect(container.textContent ?? "").toContain("the updater is not built into this build");
  });

  it("renders the refusal when the restart control throws too", async () => {
    // The second control reaches the same namespace the same way, so it must reach
    // the same boundary — without this, a fix applied to one button would pass.
    const { page: container } = await renderSettled(
      bridgeReporting(
        { status: "ready" },
        {
          requestRestart: () => {
            throw new Error("the updater cannot restart this build");
          },
        },
      ),
    );
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart to apply",
    );
    await act(async () => {
      restart?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain("the updater cannot restart this build");
  });

  it("negative control: a control that settles leaves no refusal line behind", async () => {
    // Without this, a page that rendered the aside unconditionally — or one that
    // reported a refusal on every press — would satisfy both cases above while
    // telling a person their successful check had failed.
    const { page: container } = await renderSettled(bridgeReporting({ status: "idle" }));
    await pressCheckNow(container);
    expect(container.querySelectorAll(".meridian-refusal")).toHaveLength(0);
  });
});

describe("updates page — a choice held for the window outlives the section", () => {
  /** Mount the block against one bridge and hand back the toggle plus a teardown. */
  async function mountAgainst(bridge: ConsoleBridge): Promise<{
    readonly page: HTMLElement;
    readonly toggle: HTMLElement | null;
    readonly unmount: () => void;
  }> {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    let mounted: ReturnType<typeof render> | undefined;
    await act(async () => {
      mounted = render(
        <LiveAnnouncerProvider announcer={announcer}>
          <UpdatesPage bridge={bridge} />
        </LiveAnnouncerProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const rendered = mounted as ReturnType<typeof render>;
    const page = updatesBlockOf(rendered.container);
    return {
      page,
      toggle: page.querySelector<HTMLElement>(".meridian-settings-row__switch"),
      unmount: () => {
        rendered.unmount();
      },
    };
  }

  it("keeps the choice when the section is left and re-entered", async () => {
    // The negative control for a store built per calling component: under that shape
    // the store died with this block, so returning to the section showed the default
    // while the note still promised the choice was held for the window.
    const bridge = bridgeReporting({ status: "idle" });
    const first = await mountAgainst(bridge);
    expect(first.toggle?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      first.toggle?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(first.toggle?.getAttribute("aria-checked")).toBe("false");
    expect(first.page.textContent ?? "").toContain("Held in this window");
    first.unmount();

    const second = await mountAgainst(bridge);

    expect(second.toggle?.getAttribute("aria-checked")).toBe("false");
    expect(second.page.textContent ?? "").toContain("Held in this window");
  });

  it("negative control: a different bridge starts from the default again", async () => {
    // Without this, a holder that ignored the bridge entirely would satisfy the case
    // above and then answer a swapped scenario with the previous scenario's choice.
    const first = await mountAgainst(bridgeReporting({ status: "idle" }));
    await act(async () => {
      first.toggle?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(first.toggle?.getAttribute("aria-checked")).toBe("false");
    first.unmount();

    const second = await mountAgainst(bridgeReporting({ status: "idle" }));

    expect(second.toggle?.getAttribute("aria-checked")).toBe("true");
    expect(second.page.textContent ?? "").not.toContain("Held in this window");
  });
});
