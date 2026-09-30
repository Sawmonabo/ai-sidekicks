// A dollar figure reads to four decimals at or below $0.50, so a spend of a fraction of a cent
// never reads as nothing spent.

import { describe, expect, it } from "vitest";

import { formatMoney } from "./wire-figures.js";

describe("formatMoney", () => {
  it("reads four decimals at or below $0.50 and two above, and nothing spent as $0.00", () => {
    expect(formatMoney(0.0018)).toBe("$0.0018");
    expect(formatMoney(0.0213)).toBe("$0.0213");
    expect(formatMoney(0.5)).toBe("$0.5000");
    expect(formatMoney(0.51)).toBe("$0.51");
    expect(formatMoney(11.6)).toBe("$11.60");
    expect(formatMoney(1204.5)).toBe("$1,204.50");
    expect(formatMoney(0)).toBe("$0.00");
  });
});
