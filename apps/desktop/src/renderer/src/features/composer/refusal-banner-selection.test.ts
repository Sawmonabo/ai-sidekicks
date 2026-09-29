// Which one refusal a surface holding several hands to the frame, and when it hands none.

import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import { preferredBannerClassRefusalAmong } from "./refusal-banner-selection.js";

const GONE_SESSION = refuse("runs", "session.not_found", "That session is not on this node.");
const PANE_REFUSAL = refuse("runs", "run.version_conflict", "The run moved on.");

describe("which refusal a collection hands over", () => {
  // Every caller's candidates are CONCURRENT — the approvals reader's two maps, keyed
  // by approval id and rule id and preserving first-insertion position, and the run
  // surface's list of each run's own newest settlement — so their order is the order
  // each wants them preferred and never a claim about which the daemon said last.
  it("answers with the banner-class member of a mixed set", () => {
    expect(preferredBannerClassRefusalAmong([undefined, PANE_REFUSAL, GONE_SESSION])).toStrictEqual(
      GONE_SESSION,
    );
  });

  it("answers with the FIRST banner-class candidate, which is the preferred one", () => {
    const lessPreferred = refuse("ledger", "session.not_found", "Gone before the read.");
    expect(
      preferredBannerClassRefusalAmong([undefined, GONE_SESSION, lessPreferred]),
    ).toStrictEqual(GONE_SESSION);
  });

  it("hands over ONE refusal where several noticed the same loss", () => {
    // One fact, one handover: the frame keys a banner on origin AND code, so two reads
    // that noticed one vanished session under two origins would otherwise raise two
    // banners saying one thing — each call that rejected wears its calling surface's
    // own origin.
    const atThePort = refuse("ledger", "session.not_found", "Gone before the read.");
    expect(preferredBannerClassRefusalAmong([GONE_SESSION, atThePort])).toStrictEqual(GONE_SESSION);
  });

  it("answers with nothing where the set holds no banner-class refusal", () => {
    expect(preferredBannerClassRefusalAmong([undefined, PANE_REFUSAL])).toBeUndefined();
  });

  it("negative control: an ordinary refusal stays the surface's own business", () => {
    // Without this the selector would pass while escalating everything, which would
    // put one pane's read failure across the whole session screen.
    expect(preferredBannerClassRefusalAmong([PANE_REFUSAL, undefined])).toBeUndefined();
    expect(preferredBannerClassRefusalAmong([undefined, undefined, undefined])).toBeUndefined();
  });
});
