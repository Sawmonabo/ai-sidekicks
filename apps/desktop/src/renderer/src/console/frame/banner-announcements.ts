// The frame's refusal banners, said out loud once each.
//
// `Spec-023 §Console Design (Meridian)` rule 9 makes the banner the shape a refusal
// takes when what the WHOLE ROOM can do has changed — the widest blast radius the
// grammar has. It is the frame's only event of that class, which is why it is the
// announcer's first consumer: a route change is not announced (a person who
// navigated knows where they went, and announcing it would talk over the surface
// they arrived at), and a dismissal is not announced (nothing changed for anyone
// but the person who pressed the button).
//
// THREE DECISIONS.
//
//   • **Assertive.** A banner says the room's capabilities moved under a person who
//     may be halfway through acting on the old ones. That is the one case where
//     interrupting the reader is the correct thing to do, and `live-announcer.ts`
//     reserves the assertive lane for exactly it.
//
//   • **The daemon's message, verbatim, and not the code.** Rule 9 puts the code in
//     mono because mono is a VISUAL provenance signature; spoken, `session.not_found`
//     is a token nobody can act on, read letter by letter ahead of the sentence that
//     matters. The banner itself stays in the accessibility tree carrying the code,
//     so a reader navigating by structure still reaches it — nothing is hidden, the
//     announcement is just not the place for it. The message text is passed through
//     unchanged, which is the same rule the banner renders under: the console never
//     paraphrases what the daemon said.
//
//   • **Raises only, diffed by id.** The banner list is re-supplied on every frame
//     render, so announcing the list would repeat every standing refusal on every
//     pass. The ids announced last pass are held and replaced — never accumulated —
//     so the record is bounded by the banner list itself and a banner dismissed and
//     raised again is a second, real announcement.

import { useEffect, useRef } from "react";

import { useAnnounce } from "../primitives/index.js";
import type { FrameBanner } from "../store/index.js";

/**
 * Announce each newly raised refusal banner, once, in the assertive region.
 *
 * @param banners The banners the frame is rendering right now, in raise order.
 */
export function useRefusalBannerAnnouncements(banners: readonly FrameBanner[]): void {
  const announce = useAnnounce();
  const announcedBannerIdsRef = useRef<ReadonlySet<string>>(undefined);

  useEffect(() => {
    const alreadyAnnounced = announcedBannerIdsRef.current;
    for (const banner of banners) {
      if (alreadyAnnounced?.has(banner.id) === true) {
        continue;
      }
      announce(banner.detail, "assertive");
    }
    announcedBannerIdsRef.current = new Set(banners.map((banner) => banner.id));
  }, [banners, announce]);
}
