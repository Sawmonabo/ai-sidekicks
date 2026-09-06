// Three states, and the one wrong answer this control exists to avoid.
//
// An absent projection rendered as a switch in its OFF position would present an
// enabled session as safe. So absence is its own state with a re-read, and the two
// tools are named in every state because both are registered at spawn regardless.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PeerInvocation } from "./PeerInvocation.js";

describe("peer invocation — the third state", () => {
  it("says the session did not report, and offers a re-read rather than a switch", () => {
    const { container } = render(
      <PeerInvocation enabled={undefined} onSetEnabled={() => {}} onReRead={() => {}} />,
    );
    expect(container.textContent ?? "").toContain("did not report");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector(".meridian-peer__action")).not.toBeNull();
  });

  it("negative control: a reported OFF session draws the switch, unchecked", () => {
    // Without this, the case above would pass over a control that rendered the
    // unknown state for `false` too — which is exactly the conflation at issue.
    const { container } = render(
      <PeerInvocation enabled={false} onSetEnabled={() => {}} onReRead={() => {}} />,
    );
    const control = container.querySelector('input[type="checkbox"]');
    expect(control).not.toBeNull();
    expect((control as HTMLInputElement).checked).toBe(false);
    expect(container.textContent ?? "").not.toContain("did not report");
  });

  it("draws the switch checked for a reported ON session", () => {
    const { container } = render(
      <PeerInvocation enabled onSetEnabled={() => {}} onReRead={() => {}} />,
    );
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      true,
    );
  });
});

describe("peer invocation — the tools are named regardless of the state", () => {
  it("names both in every state, with the link each produces", () => {
    for (const enabled of [undefined, false, true]) {
      const { container } = render(
        <PeerInvocation enabled={enabled} onSetEnabled={() => {}} onReRead={() => {}} />,
      );
      const tools = container.querySelector(".meridian-peer__tools")?.textContent ?? "";
      expect(tools).toContain("ask_sidekick");
      expect(tools).toContain("delegate_to_sidekick");
      expect(tools).toContain("spawn");
      expect(tools).toContain("delegate");
    }
  });

  it("negative control: the enablement text does differ between the states", () => {
    // Without this, the sweep above would pass over a control that ignored its prop
    // entirely and rendered one fixed body.
    const on = render(<PeerInvocation enabled onSetEnabled={() => {}} onReRead={() => {}} />);
    const off = render(
      <PeerInvocation enabled={false} onSetEnabled={() => {}} onReRead={() => {}} />,
    );
    expect(on.container.textContent).not.toBe(off.container.textContent);
  });
});

describe("peer invocation — visibility", () => {
  it("states that no invocation is invisible", () => {
    const { container } = render(
      <PeerInvocation enabled onSetEnabled={() => {}} onReRead={() => {}} />,
    );
    expect(container.textContent ?? "").toContain("no invisible peer invocation");
  });
});

describe("peer invocation — a change already outstanding", () => {
  it("stops taking presses and says why, where a screen reader is pointed", () => {
    const { container } = render(
      <PeerInvocation enabled={false} isPending onSetEnabled={() => {}} onReRead={() => {}} />,
    );
    const control = container.querySelector<HTMLInputElement>('input[type="checkbox"]');

    // Disabled is half the answer. A control that stops responding and says
    // nothing is indistinguishable from one that is broken, so the reason is
    // reachable from the control itself rather than only visible beside it.
    expect(control?.disabled).toBe(true);
    const describedBy = control?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent ?? "").toContain(
      "takes no second change until the first is answered",
    );
  });

  it("negative control: with nothing outstanding it is live and takes the press", () => {
    // Without this, the case above would hold for a control that is disabled and
    // silent in every state — a switch nobody can ever use.
    const pressed: boolean[] = [];
    const { container } = render(
      <PeerInvocation
        enabled={false}
        onSetEnabled={(enabled) => pressed.push(enabled)}
        onReRead={() => {}}
      />,
    );
    const control = container.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(control?.disabled).toBe(false);
    expect(control?.getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(control as HTMLElement);
    expect(pressed).toStrictEqual([true]);
  });
});
