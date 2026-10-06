// The selector's pick. Constructing the host loads nothing: `node-pty` is resolved on the first
// spawn.

import { describe, expect, it } from "vitest";

import { NodePtyHost } from "../node-pty.js";
import { selectPtyHost } from "../selector.js";

describe("selectPtyHost", () => {
  it("returns a NodePtyHost", () => {
    expect(selectPtyHost()).toBeInstanceOf(NodePtyHost);
  });
});
