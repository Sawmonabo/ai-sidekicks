// A conversation's turns, and the turn each message started, read back from Codex page by page,
// since a resume asks for no turns: a full-history resume is deprecated for paged threads.

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { CodexService } from "../service/supervisor.js";
import { CodexProviderRequestError, CodexTransportError } from "./errors.js";

/** The largest page `thread/turns/list` returns. */
const CODEX_TURNS_PAGE_LIMIT = 100;

/** Codex's refusal for a conversation no message has reached yet, which holds no turn. */
const CODEX_NOT_MATERIALIZED_MESSAGE = "is not materialized yet";

/** One turn of a conversation as `thread/turns/list` lists it. */
export interface CodexListedTurn {
  readonly id: string;
  /** The turn as Codex listed it, its `status` and `error` among its members. */
  readonly turn: Readonly<Record<string, unknown>>;
}

/**
 * Every turn of `threadId`, oldest first. A conversation no message has reached yet answers none.
 * Throws a request's failure, and `CodexTransportError` for a reply that is not a page.
 */
export async function readCodexTurns(
  service: Pick<CodexService, "request">,
  threadId: string,
): Promise<CodexListedTurn[]> {
  const newestFirst: CodexListedTurn[] = [];
  let cursor: string | null = null;
  do {
    let page: unknown;
    try {
      page = await service.request("thread/turns/list", {
        threadId,
        limit: CODEX_TURNS_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      });
    } catch (cause) {
      if (
        cause instanceof CodexProviderRequestError &&
        cause.providerMessage.includes(CODEX_NOT_MATERIALIZED_MESSAGE)
      ) {
        return [];
      }
      throw cause;
    }
    if (!isPlainObject(page) || !Array.isArray(page["data"])) {
      throw new CodexTransportError(
        'The Codex app-server "thread/turns/list" reply carried no page of turns.',
        { method: "thread/turns/list", threadId },
      );
    }
    for (const turn of page["data"]) {
      // An entry with no id is skipped: a placeholder would shift every later position.
      const id = isPlainObject(turn) ? readNonEmptyString(turn, "id") : undefined;
      if (isPlainObject(turn) && id !== undefined) {
        newestFirst.push({ id, turn });
      }
    }
    const nextCursor = page["nextCursor"];
    cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null;
  } while (cursor !== null);
  // Pages come newest first, the default order.
  return newestFirst.reverse();
}

/**
 * The turn each of the person's messages started on `threadId`, by the message's id, read from the
 * conversation's items page by page. A message sent with no id is left out. Throws a request's
 * failure, and `CodexTransportError` for a reply that is not a page.
 */
export async function readCodexTurnIdByClientMessageId(
  service: Pick<CodexService, "request">,
  threadId: string,
): Promise<Map<string, string>> {
  const turnIdByClientMessageId = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page = await service.request("thread/items/list", {
      threadId,
      ...(cursor === null ? {} : { cursor }),
    });
    if (!isPlainObject(page) || !Array.isArray(page["data"])) {
      throw new CodexTransportError(
        'The Codex app-server "thread/items/list" reply carried no page of items.',
        { method: "thread/items/list", threadId },
      );
    }
    for (const entry of page["data"]) {
      const item = isPlainObject(entry) ? entry["item"] : undefined;
      const turnId = isPlainObject(entry) ? readNonEmptyString(entry, "turnId") : undefined;
      if (!isPlainObject(item) || item["type"] !== "userMessage" || turnId === undefined) {
        continue;
      }
      // A user message carries the id its `turn/start` was sent with as `clientId`.
      const clientId = readNonEmptyString(item, "clientId");
      if (clientId !== undefined) {
        turnIdByClientMessageId.set(clientId, turnId);
      }
    }
    const nextCursor = page["nextCursor"];
    cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null;
  } while (cursor !== null);
  return turnIdByClientMessageId;
}
