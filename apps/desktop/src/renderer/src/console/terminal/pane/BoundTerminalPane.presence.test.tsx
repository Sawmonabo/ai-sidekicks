// The bound pane folds the HOST's reported reachability off the same timeline, and
// hands it to the lease fold.
//
// This is the only way the degraded state is reachable from the wire: no event links a
// hold to the machine it sits on, so a silent host with no lease transition after it is
// what makes a held lease unholdable. And the pane hands nothing over where the log
// names more than one host — the question is unanswerable there, and a pane that picked
// one would be guessing.
//
// `node-presence-model.test.ts` beside this file drives the fold directly; these cases
// are about what the PANE does with its answer.

import { describe, expect, it } from "vitest";

import { TERMINAL_HOST_NODE_ID } from "../../bridge/scenario/terminal/cast.js";
import {
  leaseBeats,
  renderPane,
  secondNodeOnlineEvent,
  storeThrough,
  storeThroughEveryBeat,
} from "./TerminalPane.test-support.js";

describe("terminal pane — the host's reported reachability", () => {
  it("degrades to unheld and read-only when the log says the one host went silent", () => {
    // The whole script: a take, and then the host that was running the shell going
    // offline with no lease transition to follow it. On the fold that passed no
    // reachability at all this frame still read as held over a surface with nothing to
    // say about the machine.
    const region = renderPane(storeThroughEveryBeat());
    expect(region.textContent).toContain("Free");
    expect(region.textContent).toContain("Nobody holds the shell.");
    expect(region.textContent).not.toContain("held from another window");
    // The node named, so a person is sent to the right machine.
    expect(region.textContent).toContain(TERMINAL_HOST_NODE_ID);
    expect(region.textContent).toContain("reads as free and stays read-only");
    expect(
      region.querySelector(".meridian-terminal-host")?.getAttribute("data-write-enabled"),
    ).toBe("false");
  });

  it("says nothing about a host's health while the log's one host is still reporting", () => {
    // The same fold one beat earlier. Without this the case above would pass
    // against a pane that reported every session degraded.
    const region = renderPane(storeThrough(leaseBeats.length));
    expect(region.textContent).toContain("The shell is held from another window.");
    expect(region.textContent).not.toContain("reads as free and stays read-only");
    expect(region.textContent).not.toContain("Node health not read");
  });

  it("checks nothing when the log names two hosts, and still shows the log's holding", () => {
    // The wire carries no link from a hold to the machine it sits on, so a second
    // attached node makes the question unanswerable. A pane that picked the offline
    // one — or the first one — would degrade this frame and would be guessing; the
    // honest answer is that nothing was checked.
    const region = renderPane(storeThroughEveryBeat([secondNodeOnlineEvent()]));
    expect(region.textContent).toContain("The shell is held from another window.");
    expect(region.textContent).toContain("Node health not read");
    expect(region.textContent).not.toContain("reads as free and stays read-only");
  });
});
