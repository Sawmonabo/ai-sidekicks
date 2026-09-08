// The one-time reveal: what a press of Copy settles, when more than one is out.
//
// EVERY CASE HOLDS THE CLIPBOARD OPEN, because the property under test lives entirely
// in the window between a press and the host's answer: a person who is not sure the
// first press landed presses again, and the host answers the two calls in whatever
// order it finishes them. A clipboard that answered immediately would close that
// window before a case could put a second press into it, and every ordering below
// would be untestable.
//
// The rest of the reveal — that the link is composed before it is rendered, that the
// token is shown once and put away on a press — is asserted through the form that
// mounts it, in `CreateInvite.test.tsx`. What is here is the one thing that form
// cannot reach: two answers arriving in the wrong order against one control.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { InviteLinkReveal, type MintedInvite } from "./InviteLinkReveal.js";

/** One mint, complete — the link is composed by the time this value exists. */
const MINTED: MintedInvite = {
  inviteId: "019b7930-0001-7000-8000-000000000001",
  expiresAt: "2026-01-08T10:05:00.000Z",
  joinMode: "collaborator",
  link: "https://control-plane.example/invite/opaque-token-under-test",
};

/** One outstanding clipboard call, with both of its answers in the case's hands. */
interface OutstandingCopy {
  /** The host took it. */
  serve(): void;
  /** The host would not. */
  refuse(): void;
}

/**
 * A clipboard that answers nothing until a case says so, and remembers every call.
 *
 * The calls are handed back in the order they were made, so a case names the press it
 * is answering by index and can answer the second one first — which is the whole
 * shape being asserted.
 */
function heldClipboard(): {
  readonly copy: () => Promise<void>;
  readonly outstanding: readonly OutstandingCopy[];
} {
  const outstanding: OutstandingCopy[] = [];
  return {
    outstanding,
    copy: () =>
      new Promise<void>((resolve, reject) => {
        outstanding.push({
          serve: () => {
            resolve();
          },
          refuse: () => {
            reject(new Error("The host would not reach the clipboard."));
          },
        });
      }),
  };
}

function renderReveal(copy: () => Promise<void>): HTMLElement {
  const { container } = render(
    <InviteLinkReveal minted={MINTED} onCopy={copy} onDone={() => undefined} />,
  );
  return container;
}

function copyControl(root: HTMLElement): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(".meridian-invite-reveal__copy");
  if (found === null) {
    throw new Error("no copy control");
  }
  return found;
}

/** Press Copy and let the call be put, without answering it. */
async function pressCopy(root: HTMLElement): Promise<void> {
  await act(async () => {
    copyControl(root).click();
    await crossMacrotaskBoundary();
  });
}

/** Let one held answer land, and the render that follows it. */
async function answer(settle: () => void): Promise<void> {
  await act(async () => {
    settle();
    await crossMacrotaskBoundary();
  });
}

describe("the invitation reveal — two presses, answered out of order", () => {
  it("keeps the newest press's answer when an older refusal lands after it", async () => {
    // THE DEFECT. The two facts were two independent fields, so a rejection that lost
    // the race wrote the refusal beside a `Copied` the later press had already put up
    // — one control reporting that the link both was and was not on the clipboard.
    const clipboard = heldClipboard();
    const container = renderReveal(clipboard.copy);
    await pressCopy(container);
    await pressCopy(container);

    await answer(() => {
      clipboard.outstanding[1]?.serve();
    });
    await answer(() => {
      clipboard.outstanding[0]?.refuse();
    });

    expect(copyControl(container).textContent).toBe("Copied");
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("keeps the newest press's refusal when an older success lands after it", async () => {
    // The same defect the other way round, and the worse half: the stale success left
    // `Copied` on a control whose newest press had just been refused, so a person sent
    // whatever their clipboard happened to be holding.
    const clipboard = heldClipboard();
    const container = renderReveal(clipboard.copy);
    await pressCopy(container);
    await pressCopy(container);

    await answer(() => {
      clipboard.outstanding[1]?.refuse();
    });
    await answer(() => {
      clipboard.outstanding[0]?.serve();
    });

    expect(copyControl(container).textContent).toBe("Copy");
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
  });

  it("puts the previous answer away the moment a fresh press is made", async () => {
    // A press supersedes the round it was made against, so the answer on screen is
    // about an attempt that no longer counts: reporting it as the state of the press
    // now outstanding is the same stale reading, one beat earlier.
    const clipboard = heldClipboard();
    const container = renderReveal(clipboard.copy);
    await pressCopy(container);
    await answer(() => {
      clipboard.outstanding[0]?.serve();
    });
    expect(copyControl(container).textContent).toBe("Copied");

    await pressCopy(container);

    expect(copyControl(container).textContent).toBe("Copy");
  });
});

describe("the invitation reveal — one press", () => {
  it("says the link is on the clipboard once the host has taken it", async () => {
    const clipboard = heldClipboard();
    const container = renderReveal(clipboard.copy);
    await pressCopy(container);
    expect(copyControl(container).textContent).toBe("Copy");

    await answer(() => {
      clipboard.outstanding[0]?.serve();
    });

    expect(copyControl(container).textContent).toBe("Copied");
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("negative control: a host that refuses is rendered rather than swallowed", async () => {
    // Without this the out-of-order cases would pass over a reveal that rendered no
    // refusal at all — which would leave a person reading a link they believe they
    // have copied and have not.
    const clipboard = heldClipboard();
    const container = renderReveal(clipboard.copy);
    await pressCopy(container);

    await answer(() => {
      clipboard.outstanding[0]?.refuse();
    });

    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(copyControl(container).textContent).toBe("Copy");
  });
});
