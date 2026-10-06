// A refused record address never carries the prose it refused: the refusal detail travels on to
// the tripwire report, so it names the component and its length and never quotes it.

import { describe, expect, it } from "vitest";

import { validatePersistedAddress } from "./value-classes.js";
import { PERSISTENCE_REFUSAL_ORIGIN } from "./refusals.js";

describe("a record's ADDRESS passes the same chokepoint as its value", () => {
  const PROSE_KEY = "Rerun the migration and tell me what the row counts look like";

  it("refuses a key that carries prose, naming the component and not quoting it", () => {
    const refusal = validatePersistedAddress("session-01H8", PROSE_KEY);

    expect(refusal?.code).toBe("address-not-identifier-shaped");
    expect(refusal?.origin).toBe(PERSISTENCE_REFUSAL_ORIGIN);
    expect(refusal?.detail).toContain("key");
    expect(refusal?.detail).toContain(String(PROSE_KEY.length));
    // The refusal must not carry the prose; its length is what finds the call site.
    expect(refusal?.detail).not.toContain(PROSE_KEY);
  });
});
