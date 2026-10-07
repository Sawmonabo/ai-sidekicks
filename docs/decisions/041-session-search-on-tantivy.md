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

`session.search` and the agents' `session_search` answer from one full-text index over session titles, message text, tool calls, group names and tags, reaching every session the list holds, archived ones included, with hits grouped by session, ranked by BM25 and with no cap on how many come back ([Spec-001 §Interfaces And Contracts](../specs/001-session-core.md#interfaces-and-contracts)). The budget is set at 10,000 sessions, 1,000,000 indexed messages, 100,000 links and 30,000 tags: a search answers in under 50 ms at p95 ([Spec-001 §Groups, Links And Tags](../specs/001-session-core.md#groups-links-and-tags)).

The daemon's database is SQLite through `better-sqlite3` ([ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md), [ADR-021](./021-v1-toolchain-selection.md)), and the search the `session-directory` unit builds answers from SQLite's own full-text index, FTS5, with the `unicode61` tokenizer and `remove_diacritics 2`. FTS5 orders matches by rank through a sorter: `fts5CursorFirstSorted` in `ext/fts5/fts5_main.c` runs `SELECT rowid, rank … ORDER BY` the rank function, so BM25 is computed for every matching row and all of them are sorted before the first page can be cut. A word that matches most messages costs as much as ranking the whole index. Spreading that work over a search thread and four ranker threads, as that unit does, keeps the daemon's main thread free but not the budget.

Measured on the `session-directory` build through its search thread and four rankers (Apple M1 Pro, 8 cores, 16 GB, macOS 27.0; Oct 7, 2026, 5:04 PM EDT, under the quiet-run lock, 1-minute load 1.9 to 2.5; 10,000 sessions and 1,000,000 messages), first page p50/p95:

| Query                  | FTS5 path                                                         |
| ---------------------- | ----------------------------------------------------------------- |
| `l` (one letter typed) | 322.1 / 329.8 ms                                                  |
| `lo`                   | 210.9 / 224.5 ms                                                  |
| `lo kalo`              | 81.6 / 85.4 ms                                                    |
| `nezi lo`              | 50.6 / 59.4 ms                                                    |
| `tag:billing nezi`     | 31.3 / 35.2 ms                                                    |
| `nezi`                 | 18.2 / 19.3 ms                                                    |
| Resident memory        | 153 MiB idle, 603 MiB after the set, still 603 MiB after 2 s idle |

A longer run at 5:33 PM (load 6.7 falling to 4.4) held every query class in budget except `lo`, at 222.0 / 247.7 ms, with the process peaking at 934 MiB. Every letter a person types into `Search all sessions` starts as a one- or two-letter prefix, so the query the box sends most is the one furthest over.

## Problem Statement

How should the daemon answer session search so that every query, a typed prefix of one letter included, ranks exactly by BM25 across every session within 50 ms at p95, and the daemon's memory returns to its idle level afterward?

### Trigger

The FTS5 path misses the budget by up to 6.6 times on short prefixes and holds about 450 MiB more after a search than before it. The person ruled on Oct 7, 2026 that search moves off FTS5 to a dedicated index.

---

## Decision

**Session search answers from a dedicated full-text index on Tantivy 0.26.2, in a native Node addon the daemon loads; SQLite stays the database and the store of record, and the index is a copy built from it.**

- **SQLite is the record.** Every write that changes searchable text (a settled message, a tool call, a title, a group name, a tag, a purge) adds an outbox row in the same SQLite transaction. The daemon applies the outbox to the index in batches and clears a row once the index commit that holds it is durable; after a crash it replays the rows still there. A missing or unreadable index is rebuilt from SQLite. Only settled messages are indexed, never streamed chunks. The index stores no message text: a hit names its row, and the line shown for it is read from SQLite.
- **Our scorer equals FTS5's BM25.** Same k1 and b, same IDF with FTS5's floor of 1e-6 for a word in more than half the rows, same document length, and the same rounding, fused multiply-add included, so a page lists the same sessions and hits in the same order that FTS5's `ORDER BY rank` gives.
- **A grouped block-max collector.** Sessions rank by their best hit. The cutoff is the k-th session's best score, less a margin of 1e-4 so a tie is never skipped, and a block of postings whose largest possible score cannot beat it is skipped unscored, Block-Max WAND applied to grouped results. Under 50,000 matching rows, one full pass is cheaper and is taken.
- **The rarest word drives.** A query of several words walks the rarest word's postings, and the cutoff it compares against is lowered by the most each other word can add, its IDF times (k1 + 1).
- **Prefix fields of one to four characters.** Each word is also indexed as its first one, two, three and four characters, one token per word in each field, so a typed prefix is one posting list and skipping applies to it.
- **Live totals.** The index keeps its own count of live rows, live tokens and each word's live row count, so a deleted message never sways a score before its segment merges.
- **Safe per-block bounds.** Each block's bound stays an upper bound when the average message length moves: it is kept as the largest frequency and the shortest length in the block, or rewritten when segments merge, so no competitive row is skipped.
- **Positioned reads, never a memory map.** Index files are read with positioned reads (`read_exact_at` on Unix; on Windows a `seek_read` branch, because tantivy-common's `WrapFile` clones the handle and seeks, and a cloned handle shares one file position). Windows cannot delete a memory-mapped file, and the reader opens files so they can be deleted while open. Segments merge when the daemon is idle, and the daemon's footprint returns to its idle level after a search.
- **Every target.** The addon is built from source for macOS arm64 and x64, Windows x64 and arm64, and Linux x64 and arm64; WSL 2 runs the Linux build ([ADR-039](./039-the-service-on-wsl-2.md)).
- **One engine.** The change that switches search deletes the FTS5 tables, the rankers and any stored rankings in the same change.

What the person sees does not change: the same hits, grouped by session, in the same order, with no cap.

### Thesis — Why This Option

- **It is exact.** On the 1,000,000-message set, pages 1 and 2 of all seven probe queries are identical to the pages FTS5's own rank builds, and so are the first 3,000 sessions of each full order; every row's score is bit-identical to FTS5's (all 113,130 rows of `lo kalo`, for one). At 10,410,000 messages, where no FTS5 copy was built, pages built with skipping equal pages built by scoring every row with the same scorer. Across three segments, after the average message length moved from 18.75 to 19.70 tokens and 30 sessions were purged, the same held.
- **It is inside the budget at the design's size with room to spare, and grows slowly past it.** Bare Rust probe, first page p50/p95:

| Query                  | 1M messages    | 10M messages     |
| ---------------------- | -------------- | ---------------- |
| `l`                    | 0.64 / 0.79 ms | 3.85 / 4.05 ms   |
| `lo`                   | 0.63 / 0.78 ms | 3.83 / 3.93 ms   |
| `nezi`                 | 0.80 / 0.94 ms | 10.31 / 10.36 ms |
| `lo kalo`              | 1.28 / 1.46 ms | 6.80 / 7.16 ms   |
| `nezi lo`              | 3.40 / 3.66 ms | 28.01 / 28.62 ms |
| `tag:billing nezi`     | 4.38 / 4.71 ms | 52.09 / 54.43 ms |
| rare word `neblegrivo` | 0.11 / 0.13 ms | 1.09 / 1.11 ms   |
| slowest next page, p95 | 4.64 ms        | 54.66 ms         |
| private memory, peak   | 18.9 MiB       | 132.6 MiB        |

- **Skipping is what buys it.** `l` at 10M scores 1,544 of 9,148,894 matching rows: 4.05 ms against 265 ms for scoring every row. `lo kalo` at 10M scores 887 of 1,132,651: 7.16 ms against 88 ms. Reading each posting list once per query and keeping the length and per-row columns between queries take `nezi` at 10M from 64.1 to 10.4 ms, for 5.6 MiB of memory at 1M and 35.6 MiB at 10M.
- **It is smaller.** 91.5 MiB on disk at 1M messages against about 432 MiB of FTS5 search tables. The probe's whole process peaks at about 19 MiB at 1M, where the FTS5 path's daemon grew from 153 to 603 MiB across the same searches.
- **The mechanism is published and proven.** Block-max skipping is Ding and Suel's Block-Max WAND; Tantivy uses it for OR queries (`BooleanWeight::for_each_pruning` calls `block_wand` for a union of terms), and Lucene keeps per-block impacts for the same purpose. Elasticsearch's `index_prefixes` and Meilisearch's word-prefix database index prefixes as their own terms, as the prefix fields do.
- **Tantivy fits the targets.** Pure Rust under the MIT license, it compiles for all six targets from one source, its index format stayed at version 7 across the last 12 months' releases, and no advisory is filed against it in GHSA, OSV or RustSec.

---

## Alternatives Considered

All options were measured on one generated set: 10,000 sessions, 1,041,000 indexed rows (and a 10× copy of 10,410,000), the same seven queries, and the pages FTS5's own rank builds as the reference.

### Option A: Tantivy 0.26.2 with our scorer, collector and reader (Chosen)

- **What:** The Decision above.
- **Steel man:** The only option measured exact on every query and inside the budget on every query at the design's size, in about 19 MiB, on every target.
- **Weaknesses:** A second store to keep in step with SQLite. About 1,600 lines of Rust in the prototype, test harness included, become a Node addon we build and ship for six targets. Tantivy has no stated commitment from its backer, Quickwit, since Quickwit joined Datadog in January 2025, and the newest 30 outside issues waited a median of 102 hours for a first reply. A durable index commit costs 65 to 67 ms at p50, which the outbox and batching absorb.

### Option B: FTS5 as built (Rejected)

- **What:** The FTS5 table with a search thread and four ranker threads, as §Context measured.
- **Steel man:** It is built, it is one store, SQLite carries it on every target with no native code of ours, and a write is one transaction. Rare and mid-frequency words, tags and later pages are inside the budget.
- **Why rejected:** FTS5 computes BM25 for every match and sorts them all before the first page (`fts5CursorFirstSorted`), so short prefixes miss by 4 to 6.6 times (`l` 329.8 ms, `lo` 224.5 ms p95) and the cost grows with every message. The threads that spread the work hold 450 MiB more after a search. FTS5's one-character prefix index does not change that: with it, counting the matches of `l*` goes from 45.3 to 32.2 ms and ranking all 915,157 rows from 606 to 573 ms, for 43.5 MiB more disk.

### Option C: FTS5 plus kept rankings (Rejected)

- **What:** For each broad word or prefix, a side table keeps each session's shortest matching row and the word's exact match count, kept current by triggers in the same write, so the session order is computed at read time from far fewer rows.
- **Steel man:** It stays one store, it is exact (every page of `lo`, `kalo` and `ne` matched hit for hit after writes, renames, purges and a 6.4% move in average row length), and it brings `lo` to 27.1 / 29.8 ms and `tag:billing/mitalo lo` from 32.9 / 35.1 to 6.7 / 7.5 ms at p50/p95.
- **Why rejected:** Measured in-process on one connection from source, under the quiet-run lock on the afternoon of Oct 7 (reads at 2:55 PM, load 4.1 falling to 2.7), every write pays for every kept word: 60 messages per write went from 124 µs per message to 181 µs with 92 kept words (+46%) and 207 µs with 243 (+67%), renames from 11.4 to about 14 ms, the largest session's purge from 2.6 s to 3.8 to 4.3 s, and disk grew 50 to 91 MiB. `l` stays at 115.6 / 117.3 ms because FTS5 has no one-character prefix index to keep, and the kept set's line between broad and narrow words must be tuned against load. Bit-equality with FTS5 also depends on whether the build fuses one multiply-add, which the arm64 build does and x64 builds may not.

### Option D: LanceDB 0.40.0 (Rejected)

- **What:** LanceDB's native full-text search (Lance 13.0.0) through its Node binding, with the same prefix columns and grouping in JavaScript. Measured Oct 7, 5:35 to 5:36 PM, under the lock, load 3.4 to 3.6.
- **Steel man:** Apache-2.0, positioned reads with no memory map on every platform, block-max skipping for OR and AND with exact lengths, one store for text and any later vectors, and a busier project (118 human authors in the last 12 months against Tantivy's 48, a first reply in about 25 hours).
- **Why rejected:** It is not exact on multi-word queries: its `_score` is a 32-bit float, which erases the 1e-6 IDF FTS5 gives a common word, so `lo kalo` differs at the second session and `nezi lo` at the fifth. It is 9 to 20 times slower on the other queries (`l` 9.52 ms p95 at 1M) and 60 to 120 times slower on two (`lo kalo` 282 ms, `nezi lo` 437 ms). Its process reached 1.30 GB of private memory across the seven queries, and capping its cache at 64 MiB left about 1 GB. New rows stay unindexed until `optimize()`, 7.1 s at 1M, and each optimize rewrites most of the index. Its npm package has had no Intel Mac build since 0.24.1, and a maintainer called one not planned, so the universal target set would mean building LanceDB, DataFusion and Arrow ourselves. Breaking-change sections appeared in 11 of its last 20 releases.

### Option E: A JavaScript engine (MiniSearch, Orama, FlexSearch) (Rejected)

- **What:** An in-process index in the daemon's own heap.
- **Steel man:** No native code, no build per target, and one language.
- **Why rejected:** MiniSearch at 100,000 messages, a tenth of the design's size, took 172.6 ms at p95 for `l`, its heap grew 105 MiB per 100,000 messages and the process reached 994 MiB. It scores with BM25+ (`calcBM25Score`), so its order cannot equal FTS5's. The whole index lives in the heap and grows with every message.

### Option F: Other engines (Rejected)

- **Xapian:** GPL version 2 or later, which the product's Apache-2.0 distribution does not take ([ADR-019](./019-v1-deployment-model-and-oss-license.md)).
- **Bleve and Lucene:** both map their index files by default (Bleve's zapx segment `Open` calls `mmap.Map`; Lucene's `FSDirectory.open` returns `MMapDirectory` on 64-bit Linux, macOS and Windows), which Windows cannot delete beneath, and Lucene would bring a Java runtime into the daemon.
- **Meilisearch:** its storage is LMDB, a memory-mapped file only, and it runs as a server of its own.

---

## Reversibility Assessment

- **Reversal cost:** Days. The index is a copy rebuilt from SQLite (23.2 s at 1M messages on four threads), so returning to an engine inside SQLite means building that table from the same rows and deleting the addon; no data moves.
- **Blast radius:** The daemon's search reads, the outbox writer and the addon's build and packaging. The wire (`session.search`, `transcript.search`, `session_search`) and every screen are unchanged.
- **Migration path:** None needed: a different engine reads the same SQLite rows, and the outbox feeds whichever index is current.
- **Point of no return:** None. The outbox and the addon's build for six targets are the parts worth keeping whatever engine sits behind them.

## Consequences

### Positive

- Every probe query is inside the budget at 1M messages with more than ten times the room, and pages are identical to FTS5's.
- The index's process peaks at about 19 MiB at 1M in the probe, where the FTS5 path's daemon grew by 450 MiB across the searches; disk drops from about 432 to 91.5 MiB.
- No ranker threads, no stored rankings to keep current, and no work at write time that grows with how many words are broad.

### Negative (accepted trade-offs)

- Two stores: SQLite and the index can disagree between a write and the batch that carries it to the index; the outbox bounds that window and a crash replays it.
- A native addon of ours, built, signed and shipped for six targets, with its own tests and its own Windows read path.
- A durable commit of the index costs about 65 ms whatever the batch size, so the index is committed in batches rather than per message.
- A full build of the index is slower than FTS5's: 23.2 s at 1M on four threads against 14.0 s plus 3.4 s to optimize.

### Unknowns

The switch is accepted when each of these is measured or built on the daemon's own build, at 10,000 sessions and 1,000,000 indexed messages unless stated, and they are the acceptance of the plan task that builds it:

- `tag:billing nezi` under 50 ms at p95 at 10M messages; it takes 54.43 ms today because every row matching the word is scored to find each tagged session's best. The fix starts from the tagged sessions' own rows when few sessions carry the tag, or stops once the two ranks the tag search merges settle the page.
- The daemon's footprint back to its idle level after searches.
- The daemon and addon overhead: the budget held through the addon and the daemon's search path, not only in the bare probe.
- Tokenizer parity with FTS5's `unicode61` and `remove_diacritics 2`: the same words matched, typed words that split into several tokens included.
- Typed prefixes of five or more characters, which have no prefix field and fall back to scoring every match.
- Match highlighting: the matched letters marked in the line shown, read from the message text in SQLite, since the index stores none.

Also not yet measured: bit-identity with FTS5 on x64, where the multiply-add may not fuse; a cold disk cache; and deep pages (page 20 of `l` approaches the 265 ms of a full order at 10M).

---

## References

### Research Conducted

Measured on an Apple M1 Pro (8 cores, 16 GB) under macOS 27.0, Oct 7, 2026, times EDT. Latency and write figures ran under the quiet-run lock, which keeps other timed work off the machine; memory, disk and build figures ran outside it, as noted.

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Tantivy probe at 1M and 10M | Primary research | Bare Rust release build, tantivy 0.26.2, tantivy-common 0.11.0, our scorer, collector and positioned-read directory; 5:11 to 5:12 PM, load 2.6 to 3.4: the latency table in §Thesis; every page identical to FTS5's at 1M and to a full scoring pass at 10M | Local probe, recorded here |
| Tantivy memory with and without a memory map | Primary research | 4:59 PM, outside the lock, load 1.9 to 2.2, peak memory footprint: 1M 18.9 MiB with positioned reads, 10.3 MiB mapped; 10M 132.6 MiB and 44.5 MiB; `l` at 10M 4.00 against 3.35 ms p95 in the same run. Memory at 10M includes 31 MiB of term dictionaries read when the index opens and about 8.5 bytes per row of kept columns | Local probe, recorded here |
| Tantivy writes | Primary research | 5:12 to 5:13 PM, load 2.5 to 2.6: 60 messages per commit 92 µs per message without fsync; a durable commit 66.95 / 102.10 ms p50/p95 at 60 per commit and 65.01 / 108.20 ms at one; build 23.2 s at 1M and 299 s at 10M on four threads; 91.5 MiB at 1M and 905 MiB at 10M with no text stored | Local probe, recorded here |
| FTS5 path on the session-directory build | Primary research | 5:04 PM and 5:33 PM through the search thread and four rankers: the table in §Context; `l` 322.1 / 329.8 ms, `lo` 210.9 / 224.5 ms; 153 MiB idle to 603 MiB after the set | Local probe, recorded here |
| FTS5 one-character prefix index | Primary research | 5:13 PM: counting `l*` 45.3 to 32.2 ms, ranking all 915,157 rows 606 to 573 ms, for 43.5 MiB more disk | Local probe, recorded here |
| FTS5 plus kept rankings | Primary research | In-process on one connection from source; reads 2:55 PM, load 4.1 to 2.7; writes earlier that afternoon under the lock, 60 messages per write: the figures in Option C | Local probe, recorded here |
| LanceDB 0.40.0 against Tantivy | Primary research | 5:35 to 5:36 PM, load 3.4 to 3.6, through its Node binding: 5 of 7 queries exact; the figures in Option D; memory outside the lock | Local probe, recorded here |
| MiniSearch at 100,000 messages | Primary research | `l` 172.6 ms p95; heap +105 MiB per 100,000 messages; process up to 994 MiB | Local probe, recorded here |
| SQLite FTS5 `fts5CursorFirstSorted` | Source file | `ORDER BY rank` runs a sorter statement over every match, so BM25 is computed for every matching row before any page | https://github.com/sqlite/sqlite/blob/version-3.53.4/ext/fts5/fts5_main.c |
| Ding and Suel, "Faster top-k document retrieval using block-max indexes", SIGIR 2011 | Paper | Block-Max WAND: a per-block score bound lets a top-k search skip blocks that cannot reach the k-th score | https://doi.org/10.1145/2009916.2010048 |
| tantivy `Weight::for_each_pruning` and `BooleanWeight::for_each_pruning` | Source file | Threshold pruning is offered to collectors; Block-WAND runs only for a union of terms (`SpecializedScorer::TermUnion`), so AND queries are not pruned | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/query/boolean_query/boolean_weight.rs |
| tantivy `PhrasePrefixQuery::weight` | Source file | A lone prefix falls back to `InvertedIndexRangeWeight`, which gives every match the same score | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/query/phrase_prefix_query/phrase_prefix_query.rs |
| tantivy `PostingsSerializer::write_block` | Source file | Each block keeps one (length, frequency) pair, the best under the BM25 weight known at write time, so the bound can understate a row's score once the average length moves | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/postings/serializer.rs |
| tantivy `InvertedIndexReader::doc_freq` and `Bm25StatisticsProvider for Searcher` | Source file | Word counts and `total_num_docs` (summed `max_doc`) include deleted rows until a merge | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/query/bm25.rs |
| tantivy-common `WrapFile::read_bytes` | Source file | Off Unix it clones the file handle and seeks, so concurrent reads share one file position; Unix uses `read_exact_at` | https://github.com/quickwit-oss/tantivy/blob/0.26.2/common/src/file_slice.rs |
| tantivy `ManagedDirectory::garbage_collect` | Source file | On Windows a delete "is expected to fail if the file is mmapped"; failed deletes are retried at the next cleanup | https://github.com/quickwit-oss/tantivy/blob/0.26.2/src/directory/managed_directory.rs |
| `DeleteFileW` | Documentation | Deleting a file that is mapped into memory fails | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew |
| Rust `OpenOptionsExt::share_mode` | Documentation | Files open with read, write and delete sharing by default, so an open file can be deleted | https://doc.rust-lang.org/std/os/windows/fs/trait.OpenOptionsExt.html |
| Lucene `Impacts` | Source file | Lucene keeps every competitive (frequency, norm) pair per block level, not one pair | https://github.com/apache/lucene/blob/releases/lucene/10.5.2/lucene/core/src/java/org/apache/lucene/index/Impacts.java |
| Elasticsearch `SinglePassGroupingCollector` | Source file | Grouped collection scores every match; its own note says propagating the minimum competitive score "is safe for grouping", and it is not done | https://github.com/elastic/elasticsearch/blob/v9.5.5/server/src/main/java/org/elasticsearch/lucene/grouping/SinglePassGroupingCollector.java |
| Elasticsearch `TextFieldMapper.Defaults` | Source file | `index_prefixes` indexes prefixes of 2 to 5 characters as their own terms | https://github.com/elastic/elasticsearch/blob/v9.5.5/server/src/main/java/org/elasticsearch/index/mapper/TextFieldMapper.java |
| Meilisearch `WordsPrefixesFst::new` | Source file | Word prefixes up to 4 bytes are kept as their own database | https://github.com/meilisearch/meilisearch/blob/v1.54.3/crates/milli/src/update/words_prefixes_fst.rs |
| Meilisearch storage | Documentation | "LMDB stores its data in a memory-mapped file" | https://www.meilisearch.com/docs/learn/engine/storage |
| Lance `idf` in `scorer.rs` | Source file | IDF is ln(1 + x) in 32-bit floats, so FTS5's 1e-6 floor and its tie-breaks cannot be reproduced | https://github.com/lance-format/lance/blob/v13.0.0/rust/lance-index/src/scalar/inverted/scorer.rs |
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

### Dependency choice

Tantivy 0.26.2, the newest release, is added to the daemon's native addon. Considered: FTS5 as built, FTS5 with kept rankings, LanceDB 0.40.0, MiniSearch and the other JavaScript engines, Xapian, Bleve, Lucene and Meilisearch. What decided it: correctness (the only engine whose pages equal FTS5's on every probe query), runtime cost (the only one inside the budget at a tenth of the memory), API fit (its postings, block bounds and segment readers are open to our own scorer and collector), licensing (MIT), and the target set (it compiles from source for all six). Its maintenance is slower than LanceDB's but its index format held across the year's releases.

### Related ADRs

- [ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md) — SQLite as the daemon's database, which stays the store of record.
- [ADR-021](./021-v1-toolchain-selection.md) — the toolchain and `better-sqlite3`, beside which the addon is built.
- [ADR-019](./019-v1-deployment-model-and-oss-license.md) — the Apache-2.0 license that rules out a GPL engine.
- [ADR-039](./039-the-service-on-wsl-2.md) — the service on WSL 2, which runs the Linux build.
