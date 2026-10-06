// Codex inbound frames: an unmapped method lands on a diagnostic, and connection-scoped frames are
// never quarantined.

import { describe, expect, it } from "vitest";

import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import {
  classifyCodexFrameFamilyForRouting,
  resolveCodexFrameEmissionRoute,
} from "../event-normalizer.js";

describe("resolveCodexFrameEmissionRoute", () => {
  function makeDiagnostics() {
    return makeSilentDriverDiagnostics();
  }

  it(
    "routes an unmapped method to the diagnostic default branch, emitted, never thrown, never " +
      "enveloped",
    () => {
      const diagnostics = makeDiagnostics();
      const route = resolveCodexFrameEmissionRoute("thread/unheard-of", diagnostics);
      expect(route.route).toBe("diagnostic");
      if (route.route === "diagnostic") {
        expect(route.record.kind).toBe("unmapped_wire_kind");
        expect(route.record.rawWireType).toBe("thread/unheard-of");
        expect(route.record.provider).toBe("codex");
      }
      expect(diagnostics.emittedRecordCount()).toBe(1);
    },
  );
});

describe("classifyCodexFrameFamilyForRouting", () => {
  it("classifies the account-plane and notice families connection-scoped", () => {
    for (const connectionScopedMethod of [
      "error",
      "account/rateLimits/updated",
      "account/chatgptAuthTokens/refresh",
      "project/changed",
      // Its payload is the empty object, so it names no thread; an unlisted method quarantines,
      // which would emit a router diagnostic on every skill-file save.
      "skills/changed",
    ]) {
      expect(classifyCodexFrameFamilyForRouting(connectionScopedMethod)).toEqual({
        scope: "connection",
      });
    }
  });
});
