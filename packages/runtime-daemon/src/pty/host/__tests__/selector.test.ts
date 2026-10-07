// The selector's pick. Constructing the host loads nothing: `node-pty` is resolved on the first
// spawn.

import { describe, expect, it } from "vitest";

import { makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import { NodePtyHost } from "../node-pty.js";
import { selectPtyHost } from "../selector.js";

describe("selectPtyHost", () => {
  it("returns a NodePtyHost", () => {
    expect(selectPtyHost(makeOrphanGuardDouble())).toBeInstanceOf(NodePtyHost);
  });
});
