# ADR-041: Session Search On Tantivy

| Field         | Value                                   |
| ------------- | --------------------------------------- |
| **Status**    | `accepted`                              |
| **Type**      | `Type 1 (two-way door)`                 |
| **Domain**    | Daemon, Search, Local Storage, Platform |
| **Date**      | 2026-10-07                              |
| **Author(s)** | Claude (AI-assisted)                    |
| **Reviewers** | Sawmon Abo                              |

---

## Context

`session.search` and the agents' `session_search` answer from one full-text index over session titles, message text, tool calls, group names and tags, reaching every session the list holds, archived ones included, with hits grouped by session, ranked by BM25 and with no cap on how many come back. `transcript.search` answers a session's own find from the same index: that session's hits newest first, with a count of every match in the session ([Spec-001 §Interfaces And Contracts](../specs/001-session-core.md#interfaces-and-contracts)). The budget is set at 10,000 sessions, 1,000,000 indexed messages, 100,000 links and 30,000 tags: a search answers in under 50 ms at p95 ([Spec-001 §Groups, Links And Tags](../specs/001-session-core.md#groups-links-and-tags)).

The daemon's database is SQLite through `better-sqlite3` ([ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md), [ADR-021](./021-v1-toolchain-selection.md)). The first candidate, built on the `session-directory` branch and measured, was SQLite's own full-text index, FTS5, with the `unicode61` tokenizer and `remove_diacritics 2`. FTS5 orders matches by rank through a sorter: `fts5CursorFirstSorted` in `ext/fts5/fts5_main.c` runs `SELECT rowid, rank … ORDER BY` the rank function, so BM25 is computed for every matching row and all of them are sorted before the first page can be cut. A word that matches most messages costs as much as ranking the whole index. That branch spread the work over a search thread and four ranker threads, which kept the daemon's main thread free but not the budget.

Measured on that branch's build through its search thread and four rankers (Apple M1 Pro, 8 cores, 16 GB, macOS 27.0; Oct 7, 2026, 5:04 PM EDT, under the quiet-run lock, 1-minute load 1.9 to 2.5; 10,000 sessions and 1,000,000 messages), first page p50/p95:

| Query                  | FTS5 candidate                                                       |
| ---------------------- | -------------------------------------------------------------------- |
| `l` (one letter typed) | 322.1 / 329.8 ms                                                     |
| `lo`                   | 210.9 / 224.5 ms                                                     |
| `lo kalo`              | 81.6 / 85.4 ms                                                       |
| `nezi lo`              | 50.6 / 59.4 ms                                                       |
| `tag:billing nezi`     | 31.3 / 35.2 ms                                                       |
| `nezi`                 | 18.2 / 19.3 ms                                                       |
| Memory footprint       | 119 MB idle, 574 MB after the probe set, still 574 MB after 2 s idle |

The probe set there was eight queries: the six above, `lope` and `tag:billing/mitalo lo`. A longer run at 5:33 PM (load 6.7 falling to 4.4) held every query class in budget except `lo`, at 222.0 / 247.7 ms, with the process's resident memory peaking at 934 MiB. Every letter a person types into `Search all sessions` starts as a one- or two-letter prefix, so the query the box sends most is the one furthest over.

## Problem Statement

How should the daemon answer session search so that every query, a typed prefix of one letter included, ranks exactly by BM25 across every session within 50 ms at p95, and the daemon's memory returns to its idle level afterward?

### Trigger

The FTS5 candidate misses the budget by up to 6.6 times on short prefixes, and its footprint grows by 455 MB across the probe set. The person ruled on Oct 7, 2026 that session search uses a dedicated index.

---

## Decision

**Session search answers from a dedicated full-text index on Tantivy 0.26.2, in a Node-API add-on built with napi-rs (`packages/search-index`) that only the daemon loads; SQLite stays the database and the store of record, and feeds the index through an outbox.**

- **SQLite is the record.** Every write that changes searchable text (a settled message, a tool call, a title, a group name, a tag, a purge) adds an outbox row in the same SQLite transaction. The daemon applies the outbox to the index in batches. Applying is idempotent by row id: a row's earlier document is deleted by its id before the new one is added, so a replay never doubles a row. Each index commit carries, in its commit payload, the id of the last outbox row it applied; after a crash the daemon replays the outbox from the row after that id. A missing or unreadable index is rebuilt from SQLite. Only settled messages are indexed, never streamed chunks.
- **The index stores no text.** A hit names its row, and the line shown for it is read from SQLite: a hit whose row is gone is dropped, and the matched letters are marked on the row's current text.
- **The scorer.** BM25 with k1 1.2 and b 0.75; IDF ln((N − n + 0.5) / (n + 0.5)), with a word in half or more of the rows weighted 1e-6; document length counted in tokens plus one; the terms summed with a fused multiply-add (`mul_add`), so every target computes the same score.
- **The tokenizer.** It splits on Unicode letters and digits and folds case and every diacritic.
- **A grouped block-max collector.** Sessions rank by their best hit. The cutoff is the k-th session's best score lowered by a relative 1e-4 (multiplied by 1 − 1e-4), so a tie is never skipped, and a block of postings whose largest possible score cannot beat it is skipped unscored: Block-Max WAND applied to grouped results. Under 50,000 matching rows, one full pass is cheaper and is taken.
- **The rarest word drives.** A query of several words walks the rarest word's postings, and the cutoff it compares against is lowered by the most each other word can add, its IDF times (k1 + 1).
- **Prefix fields of one to four characters.** Each word is also indexed as its first one, two, three and four characters, one token per word in each field, so a typed prefix is one posting list and skipping applies to it.
- **Live totals.** For each index version, each word's live row count is Tantivy's count less the deleted rows in that word's postings, found from the segments' delete lists, and the live row count and token total likewise leave the deleted rows out. They are computed once per version and cached, so a deleted message never sways a score before its segment merges, and no count is stored beside the index.
- **Safe per-block bounds.** Tantivy writes one bound per block of postings under the average length of the moment. When the average has grown since a segment was written, the bound is multiplied by the current average over that segment's average; a longer average can raise a row's score by no more than that ratio, so the bound stays an upper bound with no change to Tantivy.
- **Later pages.** A search's later pages hold the Tantivy searcher of its first page, a point-in-time view, for a bounded time, so a write between pages neither repeats a hit nor drops one.
- **Reading files.** The add-on's universal core reads index files by positioned reads on every platform: `read_exact_at` on Unix and `seek_read` on Windows, because tantivy-common's `WrapFile` clones the handle and seeks off Unix, and a cloned handle shares one file position. It never memory-maps a file on Windows, where a mapped file cannot be deleted, and it opens files so they can be deleted while open. The macOS add-on reads by a memory map where that measures smaller by footprint, macOS's own memory figure: the dirty memory the system charges the process, which is what Activity Monitor shows and what competes for RAM. Clean pages of a mapped file are counted as resident but not in the footprint, because the system drops them and reads them again from the file when it needs the room. At 1M messages the footprint is 10.3 MiB mapped against 18.9 MiB with positioned reads.
- **Merges.** Segments merge when the daemon is idle, and the daemon's footprint returns to its idle level after a search.
- **The add-on.** A Node-API add-on is ABI-stable, so one build per platform loads in the daemon's Node whatever its version, the property that settles native bindings for `better-sqlite3` ([ADR-021 §Decision](./021-v1-toolchain-selection.md#decision), its SQLite binding row; [ADR-021 §Assumptions Audit](./021-v1-toolchain-selection.md#assumptions-audit), rows 1 and 4). Only the daemon loads it, never the desktop app. Tantivy is taken with `default-features = false`, so the add-on links no stemmer, stop words, zstd or memory-map code it does not use, and the `mmap` feature is switched on for the macOS build alone.
- **Where it is built.** The `session-directory` unit builds and tests the add-on on macOS arm64 and x64 and on the Linux runner CI uses. The `windows` unit verifies the Windows x64 and arm64 builds, an index file deleted while open among them; the `linux` unit verifies the Linux x64 and arm64 builds for glibc and musl, which WSL 2 runs ([ADR-039](./039-the-service-on-wsl-2.md)), and measures their reads; the `release` unit packages, signs and checksums the add-on's per-platform packages ([Cross-Plan Dependency Graph §Platform order](../architecture/cross-plan-dependencies.md#platform-order)).

The person sees hits grouped by session, in BM25 order, with no cap.

### Thesis — Why This Option

- **It is exact.** On the 1,000,000-message set, pages 1 and 2 of all seven probe queries are identical to the pages FTS5's own rank builds, and for the six word queries so are the first 3,000 sessions of each full order; every row's score is bit-identical to FTS5's (all 113,130 rows of `lo kalo`, for one). On a set ten times larger (100,000 sessions and 10,410,000 rows, generated by the same seeder), where no FTS5 copy was built, pages built with skipping equal pages built by scoring every row with the same scorer, for the six word queries; the tag query was not compared there. Across three segments, after the average message length moved from 18.75 to 19.70 tokens and 30 sessions were purged, the same held.
- **It is inside the budget at the design's size with room to spare, and grows slowly past it.** Bare Rust probe, first page p50/p95:

| Query                  | 10k sessions, 1M messages | 100k sessions, 10M messages |
| ---------------------- | ------------------------- | --------------------------- |
| `l`                    | 0.64 / 0.79 ms            | 3.85 / 4.05 ms              |
| `lo`                   | 0.63 / 0.78 ms            | 3.83 / 3.93 ms              |
| `nezi`                 | 0.80 / 0.94 ms            | 10.31 / 10.36 ms            |
| `lo kalo`              | 1.28 / 1.46 ms            | 6.80 / 7.16 ms              |
| `nezi lo`              | 3.40 / 3.66 ms            | 28.01 / 28.62 ms            |
| `tag:billing nezi`     | 4.38 / 4.71 ms            | 52.09 / 54.43 ms            |
| rare word `neblegrivo` | 0.11 / 0.13 ms            | 1.09 / 1.11 ms              |
| slowest next page, p95 | 4.64 ms                   | 54.66 ms                    |
| memory footprint, peak | 18.9 MiB                  | 132.6 MiB                   |

- **Skipping is what buys it.** `l` at 10M scores 1,544 of 9,148,894 matching rows: 4.05 ms against 265 ms for scoring every row. `lo kalo` at 10M scores 887 of 1,132,651: 7.16 ms against 88 ms. Reading each posting list once per query takes `nezi` at 10M from 64.1 to 10.4 ms; keeping the length and per-row columns between queries saves a further 6.6 ms (16.96 to 10.36 ms), for 5.6 MiB of memory at 1M and 35.6 MiB at 10M.
- **It is smaller.** 91.5 MiB on disk at 1M messages against about 432 MiB of FTS5 search tables. By footprint, the probe's whole process peaks at 18.9 MiB at 1M; the FTS5 candidate's daemon grew from 119 MB to 574 MB across its probe set, and LanceDB's process reached 1,302 MB across the same seven queries.
- **The mechanism is published and proven.** Block-max skipping is Ding and Suel's Block-Max WAND; Tantivy uses it for OR queries (`BooleanWeight::for_each_pruning` calls `block_wand` for a union of terms), and Lucene keeps per-block impacts for the same purpose. Elasticsearch's `index_prefixes` and Meilisearch's word-prefix database index prefixes as their own terms, as the prefix fields do.
- **The dependencies.** Tantivy 0.26.2, the newest release, is MIT licensed, its index format stayed at version 7 across the last 12 months' releases, and no advisory is filed against it in GHSA, OSV or RustSec. It was chosen over the options below for correctness (the only engine whose pages equal the reference ranking on every probe query), runtime cost (the only one inside the budget, in 18.9 MiB), and API fit (its postings, block bounds and segment readers are open to our own scorer and collector); its maintenance is slower than LanceDB's. The binding is napi-rs (the `napi` crate 3.14.2, `@napi-rs/cli` 3.10.8, MIT), because it builds Node-API add-ons from Rust, generates the TypeScript declarations, and lays out one npm package per target for the `release` unit to sign; neon, the other Rust binding, was considered, and node-addon-api would put a C++ layer between Node and Rust.

---

## Alternatives Considered

All options were measured on one generated set: 10,000 sessions, 1,041,000 indexed rows, the same seven queries, and the pages FTS5's own rank builds as the reference; the Tantivy probe also ran on a set ten times larger.

### Option A: Tantivy 0.26.2 with our scorer, collector and reader (Chosen)

- **What:** The Decision above.
- **Steel man:** The only option measured exact on every query and inside the budget on every query at the design's size, in 18.9 MiB.
- **Weaknesses:** A second store fed from SQLite. About 1,600 lines of Rust in the prototype, test harness included, become an add-on we build and ship per platform. Tantivy has no stated commitment from its backer, Quickwit, since Quickwit joined Datadog in January 2025, and the newest 30 outside issues waited a median of 102 hours for a first reply. A durable index commit costs 65 to 67 ms at p50, which the outbox and batching absorb.

### Option B: FTS5 (Rejected)

- **What:** An FTS5 table with a search thread and four ranker threads, as §Context measured.
- **Steel man:** It is one store, SQLite carries it on every target with no native code of ours, and a write is one transaction. Rare and mid-frequency words, tags and later pages are inside the budget.
- **Why rejected:** FTS5 computes BM25 for every match and sorts them all before the first page (`fts5CursorFirstSorted`), so short prefixes miss by 4 to 6.6 times (`l` 329.8 ms, `lo` 224.5 ms p95) and the cost grows with every message. Its footprint grows by 455 MB across the probe set. A one-character prefix index does not change that: with `prefix='1 2 3 4'` against `prefix='2 3 4'`, counting the matches of `l*` goes from 45.3 to 32.2 ms and ranking all 915,157 rows from 606 to 573 ms, for 43.3 MiB more disk.

### Option C: FTS5 plus kept rankings (Rejected)

- **What:** For each broad word or prefix, a side table keeps each session's shortest matching row and the word's exact match count, kept current by triggers in the same write, so the session order is computed at read time from far fewer rows.
- **Steel man:** It stays one store, it is exact (every page of `lo`, `kalo` and `ne` matched hit for hit after writes, renames, purges and a 6.4% move in average row length), and it brings `lo` to 27.1 / 29.8 ms and `tag:billing/mitalo lo` from 32.9 / 35.1 to 6.7 / 7.5 ms at p50/p95.
- **Why rejected:** Measured in-process on one connection from source, under the quiet-run lock at 2:55 PM (load 4.1 falling to 2.7) against a baseline at 2:15 PM, every write pays for every kept word: 60 messages per write went from 124 µs per message to 181 µs with 92 kept words (+46%) and 207 µs with 243 (+67%), title renames from 11.4 to 14.0 to 14.6 ms, the largest session's purge from 2.6 s to 3.8 to 4.3 s, and disk grew 50 to 91 MiB. `l` stays at 115.6 / 117.3 ms because the index, built with `prefix='2 3 4'`, has no one-character prefix to keep, and the kept set's line between broad and narrow words must be tuned against load. Bit-equality with SQLite's `bm25()` also depends on whether the SQLite build fuses one multiply-add, which the arm64 build does and x64 builds may not.

### Option D: LanceDB 0.40.0 (Rejected)

- **What:** LanceDB's native full-text search (Lance 13.0.0) through its Node binding, with the same prefix columns and grouping in JavaScript. Measured Oct 7, 5:35 to 5:36 PM, under the lock, load 3.0 to 3.6.
- **Steel man:** Apache-2.0, positioned reads with no memory map on every platform, block-max skipping for OR and AND with exact lengths, one store for text and any later vectors, and a busier project (118 human authors in the last 12 months against Tantivy's 48, a first reply in about 25 hours).
- **Why rejected:** It is not exact on multi-word queries: its `_score` is a 32-bit float, which erases the 1e-6 weight of a common word, so `lo kalo` differs at the second session and `nezi lo` at the fifth. At p95 it is 11 to 17 times slower on four queries (`l` 9.52 ms at 1M) and about 120 to 190 times slower on the two multi-word queries and the rare word (`lo kalo` 281.6 ms, `nezi lo` 437.0 ms, `neblegrivo` 22.9 ms). Its process reached a footprint of 1,302 MB across the seven queries, and capping its cache at 64 MiB left about 1 GB. New rows stay unindexed until `optimize()`, 7.1 s at 1M, and each optimize rewrites most of the index. Its npm package has had no Intel Mac build since 0.24.1, and a maintainer called one not planned, so the universal target set would mean building LanceDB, DataFusion and Arrow ourselves. Breaking-change sections appeared in 11 of its last 20 releases.

### Option E: A JavaScript engine (MiniSearch, Orama, FlexSearch) (Rejected)

- **What:** An in-process index in the daemon's own heap.
- **Steel man:** No native code, no build per target, and one language.
- **Why rejected:** MiniSearch at 100,000 messages, a tenth of the design's size, took 172.6 ms at p95 for `l`, its heap grew 105 MiB per 100,000 messages and the process reached 994 MiB resident. It scores with BM25+ (`calcBM25Score`), so its order cannot equal the reference ranking. The whole index lives in the heap and grows with every message.

### Option F: Other engines (Rejected)

- **Xapian:** GPL version 2 or later, outside the MIT, Apache-2.0, BSD and ISC licenses the product's Apache-2.0 distribution takes ([ADR-019](./019-v1-deployment-model-and-oss-license.md)).
- **Bleve and Lucene:** both map their index files by default (Bleve's zapx segment `Open` calls `mmap.Map`; Lucene's `FSDirectory.open` returns `MMapDirectory` on 64-bit Linux, macOS and Windows), which Windows cannot delete beneath, and Lucene would bring a Java runtime into the daemon.
- **Meilisearch:** its storage is LMDB, a memory-mapped file only, and it runs as a server of its own.

---

## Reversibility Assessment

- **Reversal cost:** Days. The index is built from SQLite (23.2 s at 1M messages on four threads), so moving to another engine means building its index from the same rows and deleting the add-on; no data moves.
- **Blast radius:** The daemon's search reads, the outbox writer and the add-on's build and packaging. The wire (`session.search`, `transcript.search`, `session_search`) and every screen are unchanged.
- **Migration path:** None needed: another engine reads the same SQLite rows, and the outbox feeds whichever index is current.
- **Point of no return:** None. The outbox and the add-on's per-platform build are the parts worth keeping whatever engine sits behind them.

## Consequences

### Positive

- Every probe query is inside the budget at 1M messages with more than ten times the room.
- The probe's process peaks at a footprint of 18.9 MiB at 1M, and the index takes 91.5 MiB on disk.
- No work at write time grows with how common a word is.

### Negative (accepted trade-offs)

- Two stores: SQLite and the index can disagree between a write and the batch that carries it to the index; the outbox bounds that window and a crash replays it.
- A native add-on of ours, built, signed and shipped per platform, with its own tests and its own Windows read path.
- A durable commit of the index costs about 65 ms at p50 whatever the batch size, so the index is committed in batches rather than per message.
- A full build of the index takes 23.2 s at 1M on four threads, against 14.0 s plus 3.4 s to optimize for FTS5.

### Unknowns

The build is accepted when each of these is measured or built on the daemon's own build, at 10,000 sessions and 1,000,000 indexed messages unless stated; they are the acceptance of the plan task that builds it ([Plan-001](../plans/001-session-core.md) T6.9):

- Every probe query's first page under 50 ms at p95 at 100,000 sessions and 10,410,000 messages, through the add-on and the daemon's search path, `tag:billing nezi` included. The probe measured 54.43 ms for it, because every row matching the word is scored to find each tagged session's best; the fix starts from the tagged sessions' own rows when few sessions carry the tag, or stops once the two ranks the tag search merges settle the page.
- `transcript.search`: a session's hits newest first, with a count of every match in the session, under 50 ms at p95.
- The daemon's footprint back to its idle level after searches.
- The tokenizer splitting on Unicode letters and digits and folding case and every diacritic, typed words that split into several tokens included.
- Typed prefixes of five or more characters, which have no prefix field and fall back to scoring every match, inside the budget.
- Match highlighting on the row's current text, and a hit whose row is gone dropped.
- Live totals and safe per-block bounds, which the probe did not build: a purge leaves every score as if the purged rows had never been written, and a page built with skipping equals one built by scoring every row after the average length grows.
- The same score on every target: x64 builds without hardware fused multiply-add compute `mul_add` in software, at a cost not yet measured.
- The add-on built and its tests passing on each target: macOS arm64 and x64 and the CI Linux runner in `session-directory`; Windows x64 and arm64 in `windows`; Linux x64 and arm64, glibc and musl, in `linux`.
- The writer's memory arena, measured on the daemon's build against the probe's build, which used four threads of 128 MiB each and peaked at a footprint of 314.9 MiB at 1M and 739.6 MiB at 10M.
- A full rebuild's time and peak memory, against the probe's 23.2 s at 1M and 299 s at 10M on four threads.
- A merge's time and memory, against the probe's 2.0 s to merge four segments into one at 1M.
- The wait from a settled message to its being searchable: the batch interval plus a durable commit, which the probe measured at 65.01 to 66.95 ms at p50 and 102.10 to 108.20 ms at p95.

Also not yet measured: a cold disk cache, and pages deep into the order of a broad word.

---

## References

### Research Conducted

Measured on an Apple M1 Pro (8 cores, 16 GB) under macOS 27.0, Oct 7, 2026, times EDT. Latency and write figures ran under the quiet-run lock, which is meant to keep other timed work off the machine; another task's searches ran during two locked runs, about 2 s during the 10M latency run at 5:11 PM and about 7 s during the FTS5 prefix and MiniSearch run at 5:13 PM. Memory, disk and build figures ran outside the lock, as noted.

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Tantivy probe, 1M | Primary research | Bare Rust release build, tantivy 0.26.2, tantivy-common 0.11.0, our scorer, collector and positioned-read directory; locked run at 5:11 PM, load 3.0 to 3.4: the 1M column of the table in §Thesis; pages 1 and 2 of all seven queries identical to FTS5's | Local probe, recorded here |
| Tantivy probe, 10M | Primary research | Locked run at 5:11 to 5:12 PM, load 2.6 to 3.0, during which another task searched for about 2 s: the 10M column; `l` 4.05 ms p95 with positioned reads against 3.45 ms memory-mapped; pages with skipping identical to a full scoring pass for the six word queries | Local probe, recorded here |
| Tantivy memory with and without a memory map | Primary research | 4:59 PM, outside the lock, load 1.9 to 2.2, peak memory footprint: 1M 18.9 MiB with positioned reads, 10.3 MiB mapped; 10M 132.6 MiB and 44.5 MiB. At 10M about 29 MiB is resident once the index opens, and the kept length and per-row columns cost 35.6 MiB of memory, about 3.6 bytes per row; on disk those columns take about 8.5 bytes per row | Local probe, recorded here |
| Tantivy writes | Primary research | Locked run at 5:12 to 5:13 PM, load 2.5 to 2.6: 60 messages per commit 92 µs per message without fsync; a durable commit 66.95 / 102.10 ms p50/p95 at 60 per commit and 65.01 / 108.20 ms at one | Local probe, recorded here |
| Tantivy build and size | Primary research | 4:31 to 4:36 PM, outside the lock, load rising to 11.95 during the 10M build: four threads of 128 MiB; 1M built in 21.2 s and merged into one segment at 23.2 s, peak footprint 314.9 MiB, 91.5 MiB on disk with no text stored; 10M in 299 s, peak footprint 739.6 MiB, 905 MiB on disk | Local probe, recorded here |
| FTS5 candidate on the session-directory build | Primary research | 5:04 PM and 5:33 PM through the search thread and four rankers: the table in §Context; footprint 119 MB idle to 574 MB after its probe set; resident memory 153 to 603 MiB, peaking at 934 MiB in the longer run | Local probe, recorded here |
| FTS5 one-character prefix index | Primary research | Locked run at 5:13 PM: counting `l*` 45.3 to 32.2 ms, ranking all 915,157 rows 606 to 573 ms; search tables about 432 MiB, prefix b-tree 203.5 MiB with `prefix='2 3 4'` and 246.8 MiB with `prefix='1 2 3 4'` | Local probe, recorded here |
| FTS5 plus kept rankings | Primary research | In-process on one connection from source, under the lock: reads and kept writes at 2:55 PM, load 4.1 to 2.7; the baseline writes at 2:15 PM; the figures in Option C | Local probe, recorded here |
| LanceDB 0.40.0 against Tantivy | Primary research | Locked run at 5:35 to 5:36 PM, load 3.0 to 3.6, through its Node binding: 5 of 7 queries exact; the figures in Option D; memory with a capped cache outside the lock | Local probe, recorded here |
| MiniSearch 7.2.0 at 100,000 messages | Primary research | Locked run at 5:13 PM: `l` 172.6 ms p95; heap +105 MiB per 100,000 messages; process up to 994 MiB resident | Local probe, recorded here |
| macOS `footprint(1)` | Documentation | "A process's footprint is equal to the total of all Dirty memory", dirty being memory "neither backed by a file nor marked reclaimable"; clean resident memory is reported apart | `man footprint` on macOS 27.0 |
| SQLite FTS5 `fts5CursorFirstSorted` | Source file | `ORDER BY rank` runs a sorter statement over every match, so BM25 is computed for every matching row before any page | https://github.com/sqlite/sqlite/blob/version-3.53.4/ext/fts5/fts5_main.c |
| SQLite FTS5 `bm25` in `fts5_aux.c` | Source file | k1 1.2, b 0.75, and an IDF of 1e-6 wherever ln((N − n + 0.5) / (n + 0.5)) is not above zero, a word in half or more of the rows | https://github.com/sqlite/sqlite/blob/version-3.53.4/ext/fts5/fts5_aux.c |
| Ding and Suel, "Faster top-k document retrieval using block-max indexes", SIGIR 2011 | Paper | Block-Max WAND: a per-block score bound lets a top-k search skip blocks that cannot reach the k-th score | https://doi.org/10.1145/2009916.2010048 |
| tantivy `Weight::for_each_pruning` and `BooleanWeight::for_each_pruning` | Source file | Threshold pruning is offered to collectors; Block-WAND runs only for a union of terms (`SpecializedScorer::TermUnion`), so AND queries are not pruned | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/query/boolean_query/boolean_weight.rs |
| tantivy `PhrasePrefixQuery::weight` | Source file | A lone prefix falls back to `InvertedIndexRangeWeight`, which gives every match the same score | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/query/phrase_prefix_query/phrase_prefix_query.rs |
| tantivy `PostingsSerializer::write_block` | Source file | Each block keeps one (length, frequency) pair, the best under the BM25 weight known at write time, so the bound can understate a row's score once the average length grows | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/postings/serializer.rs |
| tantivy `InvertedIndexReader::doc_freq` and `Bm25StatisticsProvider for Searcher` | Source file | Word counts and `total_num_docs` (summed `max_doc`) include deleted rows until a merge | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/query/bm25.rs |
| tantivy `Cargo.toml` features | Source file | The default features are `mmap`, `stopwords`, `lz4-compression`, `columnar-zstd-compression` and `stemmer`; `mmap` brings `memmap2`, and the zstd feature compiles zstd's C library | https://github.com/quickwit-oss/tantivy/blob/0.26.2/Cargo.toml |
| tantivy-common `WrapFile::read_bytes` | Source file | Off Unix it clones the file handle and seeks, so concurrent reads share one file position; Unix uses `read_exact_at` | https://github.com/quickwit-oss/tantivy/blob/0.26.2/common/src/file_slice.rs |
| tantivy `ManagedDirectory::garbage_collect` | Source file | On Windows a delete "is expected to fail if the file is mmapped"; failed deletes are retried at the next cleanup | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/directory/managed_directory.rs |
| `DeleteFileW` | Documentation | Deleting a file that is mapped into memory fails | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew |
| Rust `OpenOptionsExt::share_mode` | Documentation | Files open with read, write and delete sharing by default, so an open file can be deleted | https://doc.rust-lang.org/std/os/windows/fs/trait.OpenOptionsExt.html |
| napi-rs CLI | Documentation | `napi create-npm-dirs` makes one npm directory per target and `napi artifacts` places each build in it; each build compiles one target; the build writes the TypeScript declarations | https://napi.rs/docs/cli/napi-config |
| Lucene `Impacts` | Source file | Lucene keeps every competitive (frequency, norm) pair per block level, not one pair | https://github.com/apache/lucene/blob/releases/lucene/10.5.2/lucene/core/src/java/org/apache/lucene/index/Impacts.java |
| Elasticsearch `SinglePassGroupingCollector` | Source file | Grouped collection scores every match; its own note says propagating the minimum competitive score "is safe for grouping", and it is not done | https://github.com/elastic/elasticsearch/blob/v9.5.5/server/src/main/java/org/elasticsearch/lucene/grouping/SinglePassGroupingCollector.java |
| Elasticsearch `TextFieldMapper.Defaults` | Source file | `index_prefixes` indexes prefixes of 2 to 5 characters as their own terms | https://github.com/elastic/elasticsearch/blob/v9.5.5/server/src/main/java/org/elasticsearch/index/mapper/TextFieldMapper.java |
| Meilisearch `WordsPrefixesFst::new` | Source file | Word prefixes up to 4 bytes are kept as their own database | https://github.com/meilisearch/meilisearch/blob/v1.54.3/crates/milli/src/update/words_prefixes_fst.rs |
| Meilisearch storage | Documentation | "LMDB stores its data in a memory-mapped file" | https://www.meilisearch.com/docs/learn/engine/storage |
| Lance `idf` in `scorer.rs` | Source file | IDF is ln(1 + x) in 32-bit floats, so a 1e-6 weight and its tie-breaks cannot be reproduced | https://github.com/lance-format/lance/blob/v13.0.0/rust/lance-index/src/scalar/inverted/scorer.rs |
| `@lancedb/lancedb` on npm | Registry | 0.40.0's optional dependencies carry no `darwin-x64` build | https://registry.npmjs.org/@lancedb%2Flancedb |
| MiniSearch `calcBM25Score` | Source file | MiniSearch scores with BM25+ | https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts |
| Bleve zapx segment `Open` | Source file | Segments are opened with `mmap.Map` | https://github.com/blevesearch/zapx/blob/master/segment.go |
| Lucene `FSDirectory.open` | Documentation | Returns `MMapDirectory` for Linux, macOS, Solaris and 64-bit Windows | https://lucene.apache.org/core/10_3_0/core/org/apache/lucene/store/FSDirectory.html |
| Xapian core `README` and `COPYING` | Source file | Licensed under the GNU General Public License version 2 or later | https://github.com/xapian/xapian/blob/master/xapian-core/README |
| Lin and Trotman, "Anytime Ranking for Impact-Ordered Indexes", ICTIR 2015 | Paper | Impact-ordered traversal stops early with approximate results; not adopted, since pages must be exact | https://doi.org/10.1145/2808194.2809477 |
| Crane et al., "A Comparison of Document-at-a-Time and Score-at-a-Time Query Evaluation", WSDM 2017 | Paper | Score-at-a-time evaluation trades exactness for bounded time; not adopted | https://doi.org/10.1145/3018661.3018726 |
| Dhulipala et al., "Compressing Graphs and Indexes with Recursive Graph Bisection", KDD 2016 | Paper | Reordering document ids speeds traversal but is an offline step over a fixed collection; not adopted for an index written live | https://doi.org/10.1145/2939672.2939862 |
| Element's seshat | Source file | Element's message search is built on tantivy 0.12 | https://github.com/matrix-org/seshat/blob/master/Cargo.toml |
| Signal Desktop `ts/sql/Server.node.ts` | Source file | Signal Desktop searches message history with SQLite FTS5 | https://github.com/signalapp/Signal-Desktop/blob/main/ts/sql/Server.node.ts |
| "Search at Slack" | Article | Slack's relevance sort is used in about 17% of searches | https://slack.engineering/search-at-slack/ |
| Tantivy and LanceDB maintenance | Registry and issues | crates.io, GitHub releases, issues and contributors since 2025-10-07: Tantivy 3 releases on crates.io, 342 issues open and 800 closed; Quickwit joined Datadog in January 2025 | https://crates.io/crates/tantivy; https://www.datadoghq.com/blog/datadog-acquires-quickwit/ |
| WSL 2 disk | Documentation | A WSL 2 distribution keeps its files on an ext4 virtual disk, so the Linux build's reads apply | https://learn.microsoft.com/en-us/windows/wsl/disk-space |

### Related ADRs

- [ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md) — SQLite as the daemon's database, which stays the store of record.
- [ADR-021](./021-v1-toolchain-selection.md) — the toolchain and the Node-API binding rule the add-on follows.
- [ADR-019](./019-v1-deployment-model-and-oss-license.md) — the license norm that rules out a GPL engine.
- [ADR-039](./039-the-service-on-wsl-2.md) — the service on WSL 2, which runs the Linux build.
