// The address guard, and the one reading the chrome is allowed to derive from.
//
// The guard gets exhaustive cases because it has exactly one catastrophic failure and
// it is silent: a spelling it misses is a page navigated to a local file, which looks
// like a successful navigation to everything above it. So the cases are the FORMS
// rather than the concept — scheme, POSIX root, home shorthand, and the five Windows
// roots that are not one leading pair of backslashes (drive-absolute, drive-relative,
// bare drive, root-relative, UNC in either separator) — each with the whitespace a
// paste carries, and beside them the ordinary web destinations the field exists to
// accept, including the one that carries a colon of its own.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SCENARIO } from "../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { isFilesystemDestination, useReportedNavigation } from "./navigation-state.js";

/**
 * Every local-path spelling, named by its FORM and paired with the verdict the
 * address field owes it.
 *
 * A table keyed by form rather than a list of examples, because the forms are what
 * differ between platforms and a list invites the reader to check the ones that look
 * alike. The Windows rows are the reason the table exists: a drive-relative
 * `C:secret.txt` and a root-relative `\\Windows\\System32` carry neither the separator
 * after the colon nor the doubled leading backslash an earlier reading required, so
 * both were dispatched as web destinations.
 *
 * The false rows sit in the same table rather than in a control of their own so that
 * a widening which starts refusing ordinary web destinations fails here, in the place
 * a reader compares the two against each other.
 */
const DESTINATION_FORMS: readonly {
  readonly form: string;
  readonly destination: string;
  readonly isLocal: boolean;
}[] = [
  { form: "file scheme", destination: "file:///etc/hosts", isLocal: true },
  {
    form: "file scheme, upper case, naming a drive",
    destination: "FILE://C:/Windows",
    isLocal: true,
  },
  { form: "POSIX absolute", destination: "/etc/hosts", isLocal: true },
  { form: "POSIX root itself", destination: "/", isLocal: true },
  { form: "home shorthand", destination: "~/Documents/report.pdf", isLocal: true },
  { form: "home itself", destination: "~", isLocal: true },
  {
    form: "Windows drive-absolute, backslash",
    destination: "C:\\Windows\\System32",
    isLocal: true,
  },
  { form: "Windows drive-absolute, forward slash", destination: "c:/Windows", isLocal: true },
  { form: "Windows drive-relative", destination: "C:secret.txt", isLocal: true },
  { form: "Windows bare drive", destination: "D:", isLocal: true },
  { form: "Windows root-relative", destination: "\\Windows\\System32", isLocal: true },
  { form: "Windows root-relative, forward slash", destination: "/Windows/System32", isLocal: true },
  { form: "UNC share, backslash", destination: "\\\\server\\share\\secret.txt", isLocal: true },
  { form: "UNC share, forward slash", destination: "//server/share/secret.txt", isLocal: true },
  { form: "Windows extended-length prefix", destination: "\\\\?\\C:\\secret.txt", isLocal: true },
  { form: "Windows device namespace", destination: "\\\\.\\pipe\\name", isLocal: true },
  { form: "https destination", destination: "https://example.invalid/page", isLocal: false },
  { form: "bare host", destination: "example.invalid", isLocal: false },
  {
    form: "host and port, which also carries a colon",
    destination: "example.invalid:8443/page",
    isLocal: false,
  },
  { form: "loopback with a port", destination: "http://localhost:5173/", isLocal: false },
  { form: "empty field", destination: "", isLocal: false },
];

describe("isFilesystemDestination", () => {
  it.each(DESTINATION_FORMS)("$form", ({ destination, isLocal }) => {
    expect(isFilesystemDestination(destination)).toBe(isLocal);
  });

  it("is not fooled by the whitespace a paste carries", () => {
    expect(isFilesystemDestination("  /etc/hosts  ")).toBe(true);
    expect(isFilesystemDestination("\tfile:///etc/hosts\n")).toBe(true);
  });

  it("negative control: the table admits as well as refuses", () => {
    // Without this, a guard that refused EVERYTHING would satisfy every true row
    // above and would also make the address field inert — and a table read row by
    // row is exactly where that goes unnoticed.
    expect(DESTINATION_FORMS.filter((row) => !row.isLocal).length).toBeGreaterThan(0);
    expect(DESTINATION_FORMS.some((row) => row.isLocal)).toBe(true);
  });

  it("does not mistake a scheme that merely starts with the same letters", () => {
    expect(isFilesystemDestination("filesystem-notes.example.invalid")).toBe(false);
  });
});

describe("useReportedNavigation", () => {
  it("reports the port's refusal and no state, which is what the wire answers today", async () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    await waitFor(() => {
      expect(result.current.refusal).toBeDefined();
    });
    expect(result.current.refusal?.code).toBe("wire-unregistered");
    // The half that matters to the chrome: no state means no navigability, so every
    // history control stays disabled rather than optimistically live.
    expect(result.current.state).toBeUndefined();
  });

  it("starts with neither, so nothing renders a reading before one arrives", () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    expect(result.current).toStrictEqual({ state: undefined, refusal: undefined });
  });
});

// The stream that is served after nobody is listening.
//
// A subscription is a resource with two ends, and the renderer only ever holds one
// of them. Between the call and its answer the pane can go, and the cleanup that
// runs in that window has nothing to close — so the arriving stream is closed by the
// arrival or by nothing at all, and "by nothing at all" costs one live bridge
// subscription and one live producer per open/close cycle, forever.
describe("useReportedNavigation — a subscription that answers after the pane has gone", () => {
  type SubscribeOutcome = Awaited<
    ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>
  >;
  type NavigationStream = Extract<SubscribeOutcome, { readonly status: "served" }>["value"];
  type NavigationEvent =
    NavigationStream["events"] extends AsyncIterable<infer Event> ? Event : never;

  /**
   * A bridge whose navigation subscription answers when the TEST says so, and a
   * stream that records its own close. The pending promise is the whole subject:
   * the fixture port answers in a microtask, which is too fast to unmount inside.
   */
  function deferredSubscription(events: readonly NavigationEvent[] = []): {
    readonly bridge: ConsoleBridge;
    readonly serve: () => void;
    readonly close: ReturnType<typeof vi.fn>;
  } {
    const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const close = vi.fn();
    let answer: ((outcome: SubscribeOutcome) => void) | undefined;
    const stream: NavigationStream = {
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<NavigationEvent> {
          yield* events;
        },
      },
      close,
    };
    return {
      close,
      serve: () => {
        answer?.({ status: "served", value: stream });
      },
      bridge: {
        ...base,
        growth: {
          ...base.growth,
          browserSubscribeNavigation: async () =>
            new Promise<SubscribeOutcome>((resolve) => {
              answer = resolve;
            }),
        },
      },
    };
  }

  it("closes it, because the cleanup that ran had nothing to close", async () => {
    const { bridge, serve, close } = deferredSubscription();
    const { unmount } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    unmount();
    serve();
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("negative control: a stream served to a live pane is drained, not closed on arrival", async () => {
    // Without this, closing every served stream on sight would satisfy the case
    // above and would also make the subscription useless: no reading would ever
    // reach the chrome, and every history control would stay disabled forever.
    const reported: NavigationEvent = {
      url: "https://example.invalid/page",
      title: "Page",
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    };
    const { bridge, serve, close } = deferredSubscription([reported]);
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    serve();
    await waitFor(() => {
      expect(result.current.state).toStrictEqual(reported);
    });
    expect(close).not.toHaveBeenCalled();
  });
});
