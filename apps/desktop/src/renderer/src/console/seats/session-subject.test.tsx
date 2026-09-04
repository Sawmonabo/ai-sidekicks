// The session-named door, and the pair predicate beside it.
//
// A door earns two tests and no more: that it FORWARDS — the guarantee it names is
// the one the holder makes, not a second one spelled here — and that its vocabulary
// is the session's. Anything else asserted here would be a second copy of
// `store/subject-scoped-state.test.tsx`, which is the drift this door exists to
// prevent.
//
// The bridges are real fixture bridges rather than shaped objects: the door's whole
// subject is bridge IDENTITY, and two casts of `{}` would prove the door compares
// references without proving it compares the reference a caller actually holds.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { consoleScenario } from "../bridge/scenario-manifest.js";
import { SessionStore } from "../store/index.js";
import { isCurrentSessionSubject, useSessionScopedState } from "./session-subject.js";

function aFixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: consoleScenario("flagship") });
}

interface DoorProbeProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
  readonly onRender: (value: string, publish: (next: string) => void) => void;
}

function DoorProbe(props: DoorProbeProps): ReactElement {
  const { value, publish } = useSessionScopedState<string>(
    props.bridge,
    props.sessionId,
    () => "seed",
  );
  props.onRender(value, publish);
  return <output>{value}</output>;
}

describe("useSessionScopedState — the session-named door forwards, and holds nothing", () => {
  it("keeps a value across a re-render and discards it when the session moves", () => {
    const bridge = aFixtureBridge();
    let latest = "";
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <DoorProbe
        bridge={bridge}
        sessionId="session-one"
        onRender={(value, publish) => {
          latest = value;
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("session one's answer");
    });
    expect(latest).toBe("session one's answer");

    view.rerender(
      <DoorProbe
        bridge={bridge}
        sessionId="session-two"
        onRender={(value, publish) => {
          latest = value;
          publishInto = publish;
        }}
      />,
    );
    expect(latest).toBe("seed");
  });

  it("discards it when the BRIDGE moves under an unchanged session", () => {
    // The reason the door's subject is the bridge and not the id: a reconnect, a
    // second window's own instance, or the fixture's scenario switch replaces the
    // transport while the session on the address stays exactly what it was.
    let latest = "";
    let publishInto: (next: string) => void = () => {};
    const record = (value: string, publish: (next: string) => void): void => {
      latest = value;
      publishInto = publish;
    };
    const view = render(
      <DoorProbe bridge={aFixtureBridge()} sessionId="session-one" onRender={record} />,
    );
    act(() => {
      publishInto("answered through the retired transport");
    });
    expect(latest).toBe("answered through the retired transport");

    view.rerender(
      <DoorProbe bridge={aFixtureBridge()} sessionId="session-one" onRender={record} />,
    );
    expect(latest).toBe("seed");
  });
});

describe("isCurrentSessionSubject — both live objects, neither reduced to a name", () => {
  const bridge = aFixtureBridge();
  const sessionStore = new SessionStore({ sessionId: "session-one" });

  it("answers true only for the exact pair it was held for", () => {
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, sessionStore)).toBe(true);
  });

  it("answers false when the projection was rebuilt for the same session", () => {
    const rebuilt = new SessionStore({ sessionId: "session-one" });
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, rebuilt)).toBe(false);
  });

  it("answers false when the transport was replaced", () => {
    expect(isCurrentSessionSubject({ bridge, sessionStore }, aFixtureBridge(), sessionStore)).toBe(
      false,
    );
  });

  it("answers false where nothing is held, or where either side is unresolved", () => {
    expect(isCurrentSessionSubject(undefined, bridge, sessionStore)).toBe(false);
    expect(isCurrentSessionSubject({ bridge, sessionStore }, undefined, sessionStore)).toBe(false);
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, undefined)).toBe(false);
  });
});
