// The announce-once latch has two homes, and the tree is held to exactly those two.
//
// `primitives/announce/reading-announcement.ts` publishes the latch and says why: a second
// arity of one rule reached that directory, and two copies of a comparison drift into
// a sentence a person hears twice with every test still green. Nothing enforced that.
// Four copies were live when this gate was written — a workflows adapter whose own
// header named its retirement, a hook inside the proposal gate's component file, an
// inline ref-and-effect in the notification preferences, and the frame's banner diff —
// and the first three were each written by somebody who had read the rule and had no
// way to be told the primitive could already serve them.
//
// THE SECOND HOME IS NAMED RATHER THAN EXEMPTED. `frame/banner-announcements.ts` is a
// latch by this reading and is deliberately not the primitive: it diffs a LIST by
// banner id and speaks into the ASSERTIVE lane, because a refusal banner says the
// whole room's capabilities moved, where the primitive holds sentences and speaks
// politely, because a surface finishing its own read is news for the person reading
// that surface and nobody else. Folding them would need a shape that is a set on one
// side and a scalar on the other and would put the two politeness lanes behind one
// call — which is the reason both primitives' headers already record. So the claim is
// a two-member roster and not a directory rule, and it fails in BOTH directions: a
// third home fails it, and a home that stopped holding a latch fails it too, because
// the second reading is what a gate whose instrument went blind looks like.
//
// The reading itself lives in `announce-latch-census.ts` and is driven against planted
// sources here, on the tier's model-and-gate split: the offending shapes have to be
// written somewhere, and writing them in the tree is what this gate forbids.

import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { announceLatchModules, declaresAnnounceLatch } from "./announce-latch-census.js";

/**
 * Where the console's announce-once latch is allowed to live.
 *
 * Two rows, each with its reason in this file's header. A diff that adds a row is
 * claiming a third comparison the tree cannot fold, and that claim belongs in a review
 * rather than in a lane.
 */
const LATCH_HOMES: readonly string[] = [
  "console/frame/banner-announcements.ts",
  "console/primitives/announce/reading-announcement.ts",
];

/** A module's text as the reading takes it, named the way a failure names it. */
function planted(source: string): { readonly displayPath: string; readonly source: string } {
  return { displayPath: "console/planted/probe.ts", source };
}

describe("announce-once latch — the reading, driven against planted sources", () => {
  it("reads the pairing as a latch, under whatever name the announcer was bound to", () => {
    // The binding is `speak` rather than `announce`, which is the case a text needle
    // over the source would miss entirely.
    expect(
      declaresAnnounceLatch(
        planted(`
          export function useSaidOnce(sentence: string | undefined): void {
            const speak = useAnnounce();
            const lastSpoken = useRef<string | undefined>(undefined);
            useEffect(() => {
              if (sentence === undefined || sentence === lastSpoken.current) {
                return;
              }
              lastSpoken.current = sentence;
              speak(sentence, "polite");
            }, [speak, sentence]);
          }
        `),
      ),
    ).toBe(true);
  });

  it("negative control: announcing what an act did is not a latch", () => {
    // The shape the artifact pane and the attachment carrier both have. It speaks from
    // a callback for an act a person just performed and remembers nothing, so a gate
    // that reported it would be asking those surfaces to route through a rule about
    // repetition they cannot repeat.
    expect(
      declaresAnnounceLatch(
        planted(`
          export function useReorderAnnouncement(): (moved: string) => void {
            const announce = useAnnounce();
            return useCallback((moved: string) => announce(moved), [announce]);
          }
        `),
      ),
    ).toBe(false);
  });

  it("negative control: a ref an effect consults without speaking is not a latch", () => {
    // The other half of the pairing, on its own. A measurement held across renders is
    // not a memory of what was said, and the two are told apart by whether the effect
    // reaches the announcer at all.
    expect(
      declaresAnnounceLatch(
        planted(`
          export function useMeasuredHeight(): void {
            const announce = useAnnounce();
            const lastHeight = useRef<number>(0);
            useEffect(() => {
              lastHeight.current = window.innerHeight;
            }, []);
            return announce;
          }
        `),
      ),
    ).toBe(false);
  });

  it("negative control: a module that never binds the announcer is not a latch", () => {
    expect(
      declaresAnnounceLatch(
        planted(`
          export function useLastValue(value: string): void {
            const previous = useRef<string | undefined>(undefined);
            useEffect(() => {
              previous.current = value;
            }, [value]);
          }
        `),
      ),
    ).toBe(false);
  });
});

describe("announce-once latch — the claim over the real tree", () => {
  const modules = consoleSourceModules().map((module) => ({
    displayPath: module.displayPath,
    source: readConsoleSourceModule(module),
  }));

  it("finds the tree it is quantified over", () => {
    // The vacuity floor both claims below need. A walk that returned nothing, or a
    // reading that resolved no announcer binding, would satisfy the roster by finding
    // nothing at all — which is what this gate looks like the day its instrument goes
    // blind rather than the day the tree is clean.
    expect(modules.length).toBeGreaterThanOrEqual(400);
    expect(modules.some((module) => module.source.includes("useAnnounce"))).toBe(true);
  });

  it("holds the latch to its two homes, in both directions", () => {
    expect([...announceLatchModules(modules)].sort()).toStrictEqual([...LATCH_HOMES].sort());
  });
});
