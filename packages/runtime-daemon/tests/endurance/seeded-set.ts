// The seeded set the session directory's budgets are measured on: 10,000 sessions, 1,000,000
// indexed messages, 100,000 links, 30,000 tags and 1,000 groups, each count multiplied by
// `SEEDED_SET_SCALE` from the environment when it is set, written through the daemon's own writer
// into a real database file, so the schema's own triggers send every row through the search
// index's outbox, and each session's projection cursor left current, so a daemon can start on it.
// The same seed and scale write the same set every run.

import { foldName } from "@ai-sidekicks/contracts/name-fold";

import { mintUuidV7 } from "../../src/uuid-v7.js";
import type { DatabaseConnections } from "../../src/database/connections.js";

/** How many of each row the seeded set holds. */
export interface SeededSetSize {
  readonly sessions: number;
  readonly messages: number;
  readonly links: number;
  readonly tags: number;
  readonly groups: number;
}

// How many times the base set a run writes: 1 unless `SEEDED_SET_SCALE` names a whole number, so
// the same classes can be measured on a set ten times larger.
const SEEDED_SET_SCALE = readSeededSetScale(process.env["SEEDED_SET_SCALE"]);

/** How large the seeded set is at the run's scale. */
export const SEEDED_SET_SIZE: SeededSetSize = {
  sessions: 10_000 * SEEDED_SET_SCALE,
  messages: 1_000_000 * SEEDED_SET_SCALE,
  links: 100_000 * SEEDED_SET_SCALE,
  tags: 30_000 * SEEDED_SET_SCALE,
  groups: 1_000 * SEEDED_SET_SCALE,
};

function readSeededSetScale(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const scale = Number(value);
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`SEEDED_SET_SCALE must be a whole number of at least 1, not "${value}".`);
  }
  return scale;
}

// The message text's vocabulary, drawn with a Zipf-like weight so a few words are very common.
const VOCABULARY_SIZE = 20_000;
const WORDS_PER_MESSAGE = 18;
const SYLLABLES = [
  "ka",
  "lo",
  "mi",
  "ne",
  "ru",
  "ta",
  "vo",
  "zi",
  "pe",
  "sa",
  "do",
  "fu",
  "gri",
  "ble",
];
const TAG_ROOTS = [
  "billing",
  "auth",
  "infra",
  "docs",
  "perf",
  "ui",
  "api",
  "release",
  "bugs",
  "research",
];
const LINK_KINDS = ["started", "copied_from", "messaged", "asked", "mentioned", "related"] as const;
const SEEDED_AT = "2026-10-06T12:00:00.000Z";
const DAY_MS = 86_400_000;
// One message in this many is the large session's, so it holds about 20,000 rows at scale 1.
const LARGE_SESSION_SHARE = 50;
// Rows per write while seeding.
const SEED_BATCH_ROWS = 5_000;

/** What a seeding wrote, for the measurements to query by. */
export interface SeededSet {
  /** Every session's id, in the order written. */
  readonly sessionIds: readonly string[];
  /** The vocabulary, most common word first. */
  readonly words: readonly string[];
  /** The session holding one message in fifty, about 20,000 rows at scale 1. */
  readonly largeSessionId: string;
  /** A session holding an even share of the messages, about 100 rows. */
  readonly typicalSessionId: string;
}

// mulberry32: integer arithmetic only, so the sequence repeats exactly and never short-cycles.
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Writes the seeded set into an empty daemon database through its writer. */
export async function seedDirectorySet(database: DatabaseConnections): Promise<SeededSet> {
  const random = seededRandom(7);
  const pick = (count: number): number => Math.floor(random() * count);
  const zipfWord = (): number =>
    Math.min(VOCABULARY_SIZE - 1, Math.floor(Math.exp(random() * Math.log(VOCABULARY_SIZE)) - 1));
  const words = Array.from({ length: VOCABULARY_SIZE }, (_, index) => {
    let remaining = index + 1;
    let word = "";
    while (remaining > 0) {
      word += SYLLABLES[remaining % SYLLABLES.length];
      remaining = Math.floor(remaining / SYLLABLES.length);
    }
    return word;
  });
  const sentence = (count: number): string =>
    Array.from({ length: count }, () => words[zipfWord()]).join(" ");
  const sessionIds = Array.from({ length: SEEDED_SET_SIZE.sessions }, () => mintUuidV7());
  const groupIds = Array.from({ length: SEEDED_SET_SIZE.groups }, () => mintUuidV7());
  const writeRows = async (sql: string, rows: readonly unknown[]): Promise<void> => {
    for (let start = 0; start < rows.length; start += SEED_BATCH_ROWS) {
      await database.writer.write([
        {
          sql,
          bindings: {
            at: SEEDED_AT,
            rows: JSON.stringify(rows.slice(start, start + SEED_BATCH_ROWS)),
          },
        },
      ]);
    }
  };

  await writeRows(
    `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
     SELECT value ->> '$[0]', 'project', value ->> '$[1]', value ->> '$[2]', @at
       FROM json_each(@rows)`,
    groupIds.map((groupId, index) => {
      const name = `${words[pick(2_000)] ?? ""} work ${index}`;
      return [groupId, name, foldName(name)];
    }),
  );
  await writeRows(
    `INSERT INTO sessions (id, shape, state, name, created_at, updated_at, last_activity_at,
                           group_id)
     SELECT value ->> '$[0]', 'project', value ->> '$[2]', value ->> '$[1]', @at, @at, @at,
            value ->> '$[3]'
       FROM json_each(@rows)`,
    sessionIds.map((sessionId) => [
      sessionId,
      sentence(3),
      random() < 0.3 ? "archived" : "active",
      random() < 0.5 ? groupIds[pick(SEEDED_SET_SIZE.groups)] : null,
    ]),
  );
  const tagRows = new Map<string, readonly [string, string]>();
  while (tagRows.size < SEEDED_SET_SIZE.tags) {
    const root = TAG_ROOTS[pick(TAG_ROOTS.length)] ?? "";
    const tag = random() < 0.5 ? root : `${root}/${words[pick(500)] ?? ""}`;
    const sessionId = sessionIds[pick(SEEDED_SET_SIZE.sessions)] ?? "";
    tagRows.set(`${sessionId}\u0000${tag}`, [sessionId, tag]);
  }
  await writeRows(
    `INSERT INTO session_tags (session_id, tag, tag_folded)
     SELECT value ->> '$[0]', value ->> '$[1]', value ->> '$[2]' FROM json_each(@rows)`,
    [...tagRows.values()].map(([sessionId, tag]) => [sessionId, tag, foldName(tag)]),
  );
  const linkRows = new Map<string, readonly unknown[]>();
  while (linkRows.size < SEEDED_SET_SIZE.links) {
    const source = pick(SEEDED_SET_SIZE.sessions);
    const target = pick(SEEDED_SET_SIZE.sessions);
    const kind = LINK_KINDS[pick(LINK_KINDS.length)] ?? "related";
    if (source !== target) {
      const lastAt = new Date(Date.parse(SEEDED_AT) - pick(90) * DAY_MS).toISOString();
      const useCount = kind === "messaged" ? 1 + pick(40) : 1;
      linkRows.set(`${String(source)}:${String(target)}:${kind}`, [
        sessionIds[source],
        sessionIds[target],
        kind,
        useCount,
        lastAt,
      ]);
    }
  }
  await writeRows(
    `INSERT INTO session_links (source_session_id, target_session_id, kind, use_count, first_at,
                                last_at)
     SELECT value ->> '$[0]', value ->> '$[1]', value ->> '$[2]', value ->> '$[3]',
            value ->> '$[4]', value ->> '$[4]'
       FROM json_each(@rows)`,
    [...linkRows.values()],
  );
  // Each session's messages in order: 40% the person's, 40% the assistant's, 20% tool calls. They
  // are made a batch at a time, so a million rows never sit in memory at once.
  const largeSessionId = sessionIds[1] ?? "";
  const nextSequence = new Map<string, number>();
  const messageRowOf = (index: number): readonly unknown[] => {
    const sessionId =
      index % LARGE_SESSION_SHARE === 0
        ? largeSessionId
        : (sessionIds[index % SEEDED_SET_SIZE.sessions] ?? "");
    const sequence = nextSequence.get(sessionId) ?? 0;
    nextSequence.set(sessionId, sequence + 1);
    const roll = random();
    const text = sentence(WORDS_PER_MESSAGE);
    if (roll < 0.4) {
      const payload = JSON.stringify({ sessionId, message: text });
      return [mintUuidV7(), sessionId, sequence, "user.message", payload, null];
    }
    if (roll < 0.8) {
      const payload = JSON.stringify({ sessionId });
      return [mintUuidV7(), sessionId, sequence, "assistant.message", payload, text];
    }
    const payload = JSON.stringify({ sessionId, toolName: "Bash" });
    const content = JSON.stringify({ command: text });
    return [mintUuidV7(), sessionId, sequence, "tool.invoked", payload, content];
  };
  for (let start = 0; start < SEEDED_SET_SIZE.messages; start += SEED_BATCH_ROWS) {
    await writeRows(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns, category,
                                   type, payload, content_payload)
       SELECT value ->> '$[0]', value ->> '$[1]', value ->> '$[2]', @at, 0, 'assistant_output',
              value ->> '$[3]', value ->> '$[4]', value ->> '$[5]'
         FROM json_each(@rows)`,
      Array.from({ length: SEED_BATCH_ROWS }, (_, offset) => messageRowOf(start + offset)),
    );
  }
  // Each session's projection cursor current at its newest event, as the log's own append leaves
  // it, so a daemon started on the set rebuilds no projection.
  await database.writer.write([
    {
      sql: `INSERT INTO projection_cursors (id, session_id, last_sequence, updated_at)
            SELECT lower(hex(randomblob(16))), session_id, MAX(sequence), @at
              FROM session_events GROUP BY session_id`,
      bindings: { at: SEEDED_AT },
    },
  ]);
  return { sessionIds, words, largeSessionId, typicalSessionId: sessionIds[2] ?? "" };
}
