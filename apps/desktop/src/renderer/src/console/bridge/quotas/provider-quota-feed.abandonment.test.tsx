// A retired quota reading reads nothing from the registry snapshot it asked for.
//
// THE DEFECT THIS CLOSES. `providerAccount.list` answers with every account the node
// holds and every quota window on each of them, and this reading takes it on three
// triggers — the open's first read, an overflow repair, and the scheduler's fire. Two
// of those carried no signal at all and the third dropped the round it was handed, so
// the last surface leaving a window still waited for that reply and still parsed the
// whole of it against its registered schema, for a reading the registry had already
// forgotten.
//
// THE EVIDENCE IS THE PARSE ITSELF, and it has to be: the readout is unmounted by the
// time the reply lands, so nothing a surface renders could tell a reading that skipped
// the parse from one that ran it and threw the answer away. So the case spies on the
// REGISTERED response schema the door itself resolves for this method — the real
// parser and not a lookalike — and the control beside it drives the same spy over a
// reading that stayed, which is what proves the spy is watching the object the door
// reaches.

import { describe, expect, it, vi } from "vitest";

import { CONSOLE_DAEMON_METHOD_BINDINGS } from "../daemon/daemon-reply-registry.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  AccountPlaneBridge,
  account,
  listReply,
  mountQuotas,
  usageWindow,
} from "./provider-quota-feed.test-support.js";

/** The parser the door resolves for the registry read, named once. */
const LIST_REPLY_SCHEMA = CONSOLE_DAEMON_METHOD_BINDINGS["providerAccount.list"].responseSchema;

/** A registry reply worth parsing: the work an abandoned read no longer pays for. */
function registryReply(): Record<string, unknown> {
  return listReply([account()], [usageWindow()]);
}

describe("the account plane's seed read — retiring the reading ends it", () => {
  it("parses nothing from a snapshot that lands after the last watcher left", async () => {
    const plane = new AccountPlaneBridge(registryReply(), { holdsReads: true });
    const mounted = await mountQuotas(plane.bridge);
    // The call really was made and is still outstanding, which is what makes this the
    // mid-flight case rather than one where nothing had been asked for yet.
    expect(plane.listCallCount).toBe(1);

    const replyParse = vi.spyOn(LIST_REPLY_SCHEMA, "safeParse");
    try {
      mounted.unmount();
      plane.settleRead();
      await crossMacrotaskBoundary();

      expect(replyParse).not.toHaveBeenCalled();
    } finally {
      replyParse.mockRestore();
    }
  });

  it("negative control: that same spy sees the parse when the watcher stays", async () => {
    // Without this the assertion above would be satisfied by a spy on a schema the
    // door never reaches, or by a fixture whose reply never arrived at all.
    const plane = new AccountPlaneBridge(registryReply(), { holdsReads: true });
    const mounted = await mountQuotas(plane.bridge);

    const replyParse = vi.spyOn(LIST_REPLY_SCHEMA, "safeParse");
    try {
      plane.settleRead();
      await crossMacrotaskBoundary();

      expect(replyParse).toHaveBeenCalledTimes(1);
      expect(mounted.readingsNow()).toHaveLength(1);
    } finally {
      replyParse.mockRestore();
      mounted.unmount();
    }
  });
});
