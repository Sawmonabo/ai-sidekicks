// What the frame says about the shell, state by state.
//
// The plane's whole value is that it is believed, so every case here is paired with
// the control that would fail the same way a wrong answer would: a window told
// nothing renders nothing, a window told something renders exactly that, and the two
// notices are independent rather than one line about "security".

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FrameStore, SHELL_DETAIL_DESTINATION, type ShellReport } from "../../store/index.js";
// A view family, reached only from a test: `frame/` may not import one, and the
// layering gate excludes test files from its graph before any rule runs. This is the
// one place the chip's destination and the rail's closed section set meet.
import { SETTINGS_SECTION_IDS } from "../../settings/settings-sections.js";
import { ShellChrome } from "./ShellChrome.js";

function storeReporting(report: Partial<ShellReport>): FrameStore {
  const store = new FrameStore({ initialRoute: { kind: "sessions" } });
  store.publishShellReport({
    connection: { kind: "connected" },
    negotiation: undefined,
    lastHeartbeatAt: undefined,
    transport: undefined,
    keystore: undefined,
    ...report,
  });
  return store;
}

describe("ShellChrome — a window told nothing", () => {
  it("renders no chrome at all", () => {
    // The claim that makes this plane honest: this build's live bridge carries no
    // channel for the shell's status, and a permanent bar reading "not checked" would
    // be furniture making a claim about a supervisor nobody asked.
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const { container } = render(<ShellChrome frameStore={store} />);
    expect(container.querySelector(".meridian-shell-state")).toBeNull();
  });

  it("renders chrome the moment something IS reported — the control", () => {
    const { container } = render(
      <ShellChrome frameStore={storeReporting({ connection: { kind: "connected" } })} />,
    );
    expect(container.querySelector(".meridian-shell-state")).not.toBeNull();
  });
});

describe("ShellChrome — the supervisor chip", () => {
  it("opens the local runtime page on a press", () => {
    // The defect: the chip was inert content while the design and the copy around it
    // promised the supervisor detail "one click away", so the advertised recovery path
    // could only be reached by guessing through Settings.
    const store = storeReporting({
      connection: { kind: "offline", attemptLimit: 5, lastError: undefined },
    });
    const { getByRole } = render(<ShellChrome frameStore={store} />);

    act(() => {
      getByRole("button", { name: /open the local runtime page/iu }).click();
    });

    // The route the shell vocabulary declares, which is also the id the settings rail
    // lists — asserted as the route value rather than as a hash, because a hand-built
    // address is exactly what the navigation may not be.
    expect(store.getState().route).toStrictEqual(SHELL_DETAIL_DESTINATION.route);
  });

  it("lands on a section the settings rail actually lists", () => {
    // The coupling the DAG cannot express as an import: `frame/` may not reach a view
    // family, so the destination is declared in `store/shell-state.ts` and the rail's
    // closed enumeration lives in `settings/`. A rename on either side fails here
    // rather than shipping a chip that opens a page nothing answers for.
    expect([...SETTINGS_SECTION_IDS]).toContain(SHELL_DETAIL_DESTINATION.section);
    expect(SHELL_DETAIL_DESTINATION.route).toStrictEqual({
      kind: "settings",
      page: SHELL_DETAIL_DESTINATION.section,
    });
  });

  it("keeps the state itself as the label, so the name says both things", () => {
    const { getByRole } = render(
      <ShellChrome frameStore={storeReporting({ connection: { kind: "connected" } })} />,
    );
    // The visible label is contained in the accessible name rather than replaced by
    // it: a person who reads "Local runtime connected" and a person who hears the
    // control are told the same thing plus where it goes.
    const control = getByRole("button", { name: /open the local runtime page/iu });
    expect(control.textContent).toContain("Local runtime connected");
  });

  it("leaves the absence inert — the control", () => {
    // A window told nothing renders `Nothing`, and a button around "nobody has said"
    // would offer a detail page for a supervisor this build has no channel to ask
    // about. The strip still renders here, because the keystore notice earned it.
    //
    // Both arms are queried off their OWN container rather than through the render
    // result's role query, which is scoped to the document and would answer with
    // whichever of the two mounts came first.
    const unreported = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "unreported" },
          keystore: "unavailable",
        })}
      />,
    );
    expect(unreported.container.querySelector(".meridian-shell-state__detail")).toBeNull();
    expect(unreported.container.querySelector(".meridian-nothing")).not.toBeNull();

    // And the reported window beside it does offer one, so the assertion above is
    // about the arm rather than about the query.
    const reported = render(
      <ShellChrome frameStore={storeReporting({ connection: { kind: "connected" } })} />,
    );
    expect(reported.container.querySelector(".meridian-shell-state__detail")).not.toBeNull();
  });
});

describe("ShellChrome — the outage banners", () => {
  it("names the attempt out of the ladder while reconnecting", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
        })}
      />,
    );
    expect(container.textContent).toContain("attempt 2 of 5");
  });

  it("names every blocked act on the read-only line", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "reconnecting", attempt: 1, attemptLimit: 5 },
        })}
      />,
    );
    const text = container.textContent ?? "";
    for (const act of [
      "starting a session",
      "joining a session",
      "interrupting a run",
      "answering a provider's question",
      "compacting a session's context",
    ]) {
      expect(text, act).toContain(act);
    }
  });

  it("offers the retry only once the supervisor has stopped driving", () => {
    // During the backoff window the supervisor owns the reconnect, and a second
    // retry beside it would race the ladder.
    const reconnecting = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "reconnecting", attempt: 1, attemptLimit: 5 },
        })}
        onRetry={() => undefined}
      />,
    );
    expect(reconnecting.queryByRole("button", { name: "Start the local runtime" })).toBeNull();

    const offline = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "offline", attemptLimit: 5, lastError: undefined },
        })}
        onRetry={() => undefined}
      />,
    );
    expect(offline.getByRole("button", { name: "Start the local runtime" })).toBeTruthy();
  });

  it("renders no banner at all while connected — the control", () => {
    const { container } = render(
      <ShellChrome frameStore={storeReporting({ connection: { kind: "connected" } })} />,
    );
    expect(container.querySelector(".meridian-shell-state__banners")).toBeNull();
  });
});

describe("ShellChrome — the catch-up banner", () => {
  it("says what is being re-read, from the store's own cause", () => {
    // Folded from the session stores this window holds rather than reported by the
    // shell: a gap is something THIS window's subscription noticed.
    const store = storeReporting({ connection: { kind: "connected" } });
    store.publishSessionRecovery("sequence-gap");
    const { container } = render(<ShellChrome frameStore={store} />);
    expect(container.textContent).toContain("re-reading");
  });

  it("clears when the cause does — the control", () => {
    const store = storeReporting({ connection: { kind: "connected" } });
    store.publishSessionRecovery("sequence-gap");
    store.publishSessionRecovery(undefined);
    const { container } = render(<ShellChrome frameStore={store} />);
    expect(container.querySelector(".meridian-shell-state__banners")).toBeNull();
  });
});

describe("ShellChrome — the version banner", () => {
  const negotiation = {
    compatible: false,
    daemonProtocolVersion: "2026-04-30",
    consoleProtocolVersion: "2026-08-14",
    daemonSupportedProtocols: ["2026-04-30", "2026-05-28"],
    reason: "version.ceiling_exceeded",
  };

  it("says the RUNTIME moves when this console is above the ceiling", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({ connection: { kind: "version-incompatible" }, negotiation })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Update the local runtime");
    expect(text).toContain("2026-04-30, 2026-05-28");
  });

  it("says the CONSOLE moves when it is below the floor — the other arm", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "version-incompatible" },
          negotiation: { ...negotiation, reason: "version.floor_exceeded" },
        })}
      />,
    );
    expect(container.textContent).toContain("Update the console");
  });

  it("guesses at neither side for a reason it does not know", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({
          connection: { kind: "version-incompatible" },
          negotiation: { ...negotiation, reason: "something.new" },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("will not guess");
    expect(text).not.toContain("Update the console.");
  });
});

describe("ShellChrome — the two notices", () => {
  it("renders the loopback notice alone", () => {
    const { container } = render(
      <ShellChrome frameStore={storeReporting({ transport: "loopback", keystore: "available" })} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Loopback transport is in use");
    expect(text).not.toContain("memory-only");
  });

  it("renders the keystore notice alone, and says what memory-only costs", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({ transport: "os-local", keystore: "unavailable" })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("memory-only");
    expect(text).toContain("sign-in is required again next launch");
    expect(text).not.toContain("Loopback transport is in use");
  });

  it("renders both at once", () => {
    const { container } = render(
      <ShellChrome
        frameStore={storeReporting({ transport: "loopback", keystore: "unavailable" })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Loopback transport is in use");
    expect(text).toContain("memory-only");
  });

  it("renders neither on a healthy host — the control", () => {
    const { container } = render(
      <ShellChrome frameStore={storeReporting({ transport: "os-local", keystore: "available" })} />,
    );
    expect(container.querySelector(".meridian-shell-state__notices")).toBeNull();
  });

  it("offers no way to dismiss either of them", () => {
    // A degraded security posture is not a detail behind a chevron, and a dismissal
    // would remove the one line telling a person their sign-in dies at quit.
    const { queryByRole } = render(
      <ShellChrome
        frameStore={storeReporting({ transport: "loopback", keystore: "unavailable" })}
      />,
    );
    expect(queryByRole("button", { name: /dismiss/iu })).toBeNull();
  });
});
