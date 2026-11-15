// A send that fails after the feed's first read settled is said through the window's one
// announcer: the failed line's words when a send of this window fails or its line's words change,
// and `Not delivered` when a waiting message's delivery fails. The rows are drawn and drawn again
// as the reader scrolls, so the feed says each failure once, as it arrives; what already stood
// when the feed mounted, or when the queue was first read, is reached by browsing.

import { useEffect, useRef, useSyncExternalStore } from "react";

import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { QueueFeed } from "../reading.js";
import { NOT_DELIVERED_WORDS } from "../waiting-rows.js";

/** Says each send failure that arrives while the feed is mounted, once. */
export function useAnnounceSendFailures(sessionStore: SessionStore, queue: QueueFeed): void {
  const announce = useAnnounce();
  const { sentMessages } = sessionStore;
  const entries = useSyncExternalStore(sentMessages.subscribe, sentMessages.snapshot);
  // Each failed line's words as last said or found standing, by its send's key.
  const lineWords = useRef<Map<string, string> | undefined>(undefined);
  useEffect(() => {
    const isFirstRead = lineWords.current === undefined;
    const held = (lineWords.current ??= new Map<string, string>());
    for (const entry of entries) {
      const replacing = held.get(entry.key);
      if (entry.kind !== "failed" || replacing === entry.label) {
        continue;
      }
      held.set(entry.key, entry.label);
      if (!isFirstRead) {
        announce(entry.label, "assertive", { replacing });
      }
    }
  }, [entries, announce]);
  // The messages whose delivery failed, as found on the queue's first read and since.
  const notDeliveredItemIds = useRef<Set<string> | undefined>(undefined);
  const { items, phase } = queue;
  useEffect(() => {
    if (phase === "reading") {
      return;
    }
    const isFirstRead = notDeliveredItemIds.current === undefined;
    const held = (notDeliveredItemIds.current ??= new Set<string>());
    for (const item of items) {
      if (item.kind !== "message" || item.state !== "notDelivered" || held.has(item.id)) {
        continue;
      }
      held.add(item.id);
      if (!isFirstRead) {
        announce(NOT_DELIVERED_WORDS, "assertive");
      }
    }
  }, [items, phase, announce]);
}
