// `NodeIdSchema` accepts a non-UUID opaque id up to its length cap.
import { describe, expect, it } from "vitest";

import { NODE_ID_MAX_LEN, NodeIdSchema } from "../node-id.js";

describe("NodeIdSchema (non-UUID opaque daemon-assigned brand)", () => {
  it("accepts a plain non-empty string (does NOT require UUID format)", () => {
    expect(NodeIdSchema.safeParse("node-daemon-abc123").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(NodeIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects an oversized node id (defense-in-depth length cap)", () => {
    expect(NodeIdSchema.safeParse("x".repeat(NODE_ID_MAX_LEN + 1)).success).toBe(false);
  });

  it("accepts a node id at exactly the length cap (boundary)", () => {
    expect(NodeIdSchema.safeParse("x".repeat(NODE_ID_MAX_LEN)).success).toBe(true);
  });
});
