// contract-ddl-conformance.test.ts — the I-010-2 contract↔DDL lockstep
// tripwire (Plan-010 Phase 1 T1.4). First file in the Plan-010-owned
// `src/git/` subtree (CP-010-7).
//
// Spec coverage:
//   * `Spec-010 §Required Behavior` — the worktree lifecycle state set is one
//     vocabulary, not two: what `worktree.ts` declares and what the
//     `worktrees.state` CHECK admits are the same six values, in the same
//     order.
//
// Invariants covered (canonical text in
// `docs/plans/010-worktree-lifecycle-and-execution-modes.md §Invariants`):
//   * I-010-2 — contract↔DDL lockstep: `WorktreeState`, `EphemeralCloneState`,
//     and the cleanup-policy literal union "are byte-identical between
//     `worktree.ts` and the migration `CHECK` constraints". This file IS the
//     conformance test that invariant names. What is MECHANICALLY asserted is
//     the enum VOCABULARY — same members, same order — not literal bytes: the
//     DDL spells a member `'creating'` and the contract spells it
//     `"creating"`, so byte equality across the two surfaces is not a
//     well-formed comparison. Vocabulary + order is the strongest claim the
//     two representations can share, and it is the one the invariant means.
//
// Scope boundary. `session/__tests__/migration-shape.test.ts` owns the
// BEHAVIORAL half of the version-4 schema (PRAGMA column/index shape plus
// accept/reject inserts against a live database) and explicitly defers
// byte-lockstep here. This file never opens a database: it reads the exported
// migration SQL as text, extracts the enum vocabularies out of the `CHECK`
// clauses, and compares them against the contract enums. The two are
// complementary — a behavioral test proves SQLite enforces *something*, this
// one proves the something is exactly what the contract promises.
//
// ---------------------------------------------------------------------------
// Extraction contract — why this is a text parse, and how it fails closed
// ---------------------------------------------------------------------------
//
// A string-extraction tripwire has one dominant failure mode: the extractor
// stops matching, compares empty to empty, and passes forever while the drift
// it exists to catch walks straight through. Every guard below exists for that
// one reason, and each is asserted rather than assumed:
//
//   1. TABLE CENSUS — exactly four `CREATE TABLE` blocks, by name. A renamed
//      table makes its enum lookup miss, and a lookup miss THROWS
//      (`ddlEnumVocabulary`) instead of yielding an empty set.
//   2. CHECK CENSUS — exactly six `CHECK` clauses: four enum clauses plus two
//      non-enum predicates (`branch_contexts`'s at-most-one-root clause and
//      `run_execution_contexts`'s mode-conditional clause). The predicates are
//      classified and counted, never silently swallowed.
//   3. RECONCILIATION AGAINST AN ABSOLUTE EXPECTATION — the per-table census
//      (a quote-aware paren walk) and the whole-SQL keyword count (a flat
//      regex) are two mechanisms, so a walk that loses a block cannot also hide
//      the loss. Their independence is REAL BUT PARTIAL: both consume the
//      output of `stripSqlLineComments`, so a stripper bug that eats a CHECK
//      eats it from both counts and they agree at 5.
//      What actually backstops that shared layer is `EXPECTED_TOTAL_CHECK_COUNT`
//      being ABSOLUTE — derived from the expectation tables (`LOCKSTEP_ROWS` +
//      `EXPECTED_PREDICATE_TABLES`) and NEVER from extraction output. 5 ≠ 6
//      fails no matter how consistently the two mechanisms agree with each
//      other. Do not "simplify" that assertion into another extraction-vs-
//      extraction comparison; it is the only guard the stripper cannot fool.
//   4. UNRECOGNIZED SHAPES THROW — any clause containing an `IN (...)`
//      sub-expression must parse completely as `<column> IN (<string literal
//      list>)`, residue and comma count included. An enum clause written in a
//      shape the parser does not understand is an error, never a skip.
//   5. NON-EMPTY VOCABULARIES — asserted per clause, and re-checked inside the
//      comparator itself, so an empty-vs-empty comparison can never return
//      "conforming".
//   6. MUTATION CANARIES — deliberately-wrong inputs driven through the SAME
//      extract→compare path the real assertions use (never a parallel
//      reimplementation), proving the comparison can actually fail.
//
// The migration's own header (`0004-worktree-lifecycle.ts`) declares that this
// test string-extracts its CHECK clauses and asks that the constant stay
// exported and the clauses byte-verbatim. Guards 1-4 are what make that
// request enforceable rather than aspirational.

import { describe, expect, it } from "vitest";

import {
  CleanupPolicySchema,
  EphemeralCloneStateSchema,
  ExecutionModeSchema,
  WorktreeStateSchema,
} from "@ai-sidekicks/contracts";

import { WORKTREE_LIFECYCLE_MIGRATION_SQL } from "../../migrations/0004-worktree-lifecycle.js";

// ---------------------------------------------------------------------------
// SQL text extraction
// ---------------------------------------------------------------------------

// Global-flagged regexes carry mutable `lastIndex`, so they are minted per use
// rather than shared as module constants — a stale `lastIndex` leaking between
// tests is its own species of silent skip. The two stateless patterns below
// stay constants.
const newCreateTableStartPattern = (): RegExp =>
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
const newCheckKeywordPattern = (): RegExp => /\bCHECK\b/gi;
const newStringLiteralPattern = (): RegExp => /'((?:[^']|'')*)'/g;

/** Full-match shape of an enum constraint: `<column> IN (<literal list>)`. */
const ENUM_CHECK_PATTERN: RegExp = /^([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\(([\s\S]*)\)$/i;
/** Cheap discriminator: does this clause contain an `IN` list at all? */
const CONTAINS_IN_LIST_PATTERN: RegExp = /\bIN\s*\(/i;

/**
 * Strips `--` line comments, quote-aware.
 *
 * The migration's comments carry parenthesized prose (`(mount, branch)`,
 * `(absolute)`, `(Spec-010 §Interfaces)`) and quoted state names
 * (`including 'merged'`), so a paren walk or literal scan over the raw text
 * would read commentary as syntax. Stripping first removes the whole class.
 *
 * SQLite escapes a quote inside a string literal by doubling it (`''`); the
 * scanner honors that, so a future literal containing an apostrophe cannot
 * desynchronize the in-string state. An unterminated literal throws — that is
 * not SQL this parser can be trusted on.
 */
function stripSqlLineComments(sql: string): string {
  let stripped = "";
  let index = 0;
  let insideStringLiteral = false;

  while (index < sql.length) {
    // `charAt` (not `sql[index]`) throughout: under `noUncheckedIndexedAccess`
    // bracket access is `string | undefined`, and the out-of-range answer we
    // want here is the empty string, not a null check on every read.
    const character = sql.charAt(index);

    if (insideStringLiteral) {
      stripped += character;
      if (character === "'") {
        if (sql.charAt(index + 1) === "'") {
          // Escaped quote — consume both halves and stay inside the literal.
          stripped += "'";
          index += 2;
          continue;
        }
        insideStringLiteral = false;
      }
      index += 1;
      continue;
    }

    if (character === "'") {
      insideStringLiteral = true;
      stripped += character;
      index += 1;
      continue;
    }

    if (character === "-" && sql.charAt(index + 1) === "-") {
      // Discard through end of line; the newline itself is kept so line
      // structure (and with it statement separation) survives.
      const lineEndIndex = sql.indexOf("\n", index);
      if (lineEndIndex === -1) {
        break;
      }
      index = lineEndIndex;
      continue;
    }

    stripped += character;
    index += 1;
  }

  if (insideStringLiteral) {
    throw new Error("Migration SQL has an unterminated string literal — refusing to parse it.");
  }

  return stripped;
}

/**
 * Index of the `)` matching the `(` at `openParenIndex`, quote-aware.
 *
 * An earlier version of this docstring justified the quote tracking with the
 * version-4 anchor row's parenthesized description literal. That was wrong on
 * two counts: the walk never reaches it (after the fourth table
 * `createTablePattern.lastIndex` advances past the body and no further
 * `CREATE TABLE` matches), and its parens are balanced anyway.
 *
 * The real motivator is upstream, in `stripSqlLineComments`, which runs the
 * same quote state machine: the migration's comments carry unbalanced
 * apostrophes: FIVE unpaired possessives — `git's` in the comment above
 * `idx_worktrees_active_branch`, `run's` and `campaign's` above
 * `run_execution_contexts`, and `clone's` twice on the `git_common_dir` note —
 * alongside one genuinely quoted `'merged'`. A scanner that did not track
 * literals would flip into "inside a string" on `git's` and mis-read every
 * paren after it. Comment-stripping first is a precondition for this walk, not
 * tidiness.
 *
 * Within this function the quote branch is currently unexercised: no literal in
 * any table body contains a paren today. It is kept deliberately, as the
 * forward-looking half of the same invariant — a future `CHECK` whose literal
 * carries a paren (a default expression, a formatted label) must not desync the
 * walk. It is cheap and its absence would fail silently.
 */
function findMatchingCloseParenIndex(sql: string, openParenIndex: number): number {
  let depth = 0;
  let insideStringLiteral = false;

  for (let index = openParenIndex; index < sql.length; index += 1) {
    const character = sql.charAt(index);

    if (insideStringLiteral) {
      if (character === "'") {
        if (sql.charAt(index + 1) === "'") {
          index += 1;
          continue;
        }
        insideStringLiteral = false;
      }
      continue;
    }

    if (character === "'") {
      insideStringLiteral = true;
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error(
    `Migration SQL has an unbalanced parenthesis opened at offset ${openParenIndex} — refusing to parse it.`,
  );
}

/** An enum `CHECK`: `<column> IN ('a', 'b', …)`. */
interface EnumCheckClause {
  readonly kind: "enum";
  readonly tableName: string;
  readonly columnName: string;
  readonly values: readonly string[];
}

/** A non-enum `CHECK` — a row-level predicate over column presence/equality. */
interface PredicateCheckClause {
  readonly kind: "predicate";
  readonly tableName: string;
  /**
   * Whitespace-collapsed, for reporting and for census "is it non-empty"
   * checks: re-indenting the DDL must not read as a semantic change.
   *
   * NEVER extract string literals from this. Collapsing runs INSIDE literals
   * too, so `'ephemeral  clone'` folds back into `'ephemeral clone'` — and
   * `'ephemeral clone'` is the one space-bearing member of the execution-mode
   * vocabulary, which is exactly what makes that typo plausible and its arm
   * unsatisfiable. Use `verbatimExpression` for anything comparing literals.
   */
  readonly expression: string;
  /**
   * The clause body trimmed but otherwise byte-verbatim — the literal-
   * extraction source, and the reason a doubled space inside an arm literal
   * survives to be compared rather than being normalized away first.
   */
  readonly verbatimExpression: string;
}

type CheckClause = EnumCheckClause | PredicateCheckClause;

interface ExtractedMigration {
  readonly tableNames: readonly string[];
  readonly checkClauses: readonly CheckClause[];
  /** Whole-SQL `CHECK` keyword count, derived independently of the paren walk. */
  readonly independentCheckKeywordCount: number;
}

const isEnumCheckClause = (clause: CheckClause): clause is EnumCheckClause =>
  clause.kind === "enum";
const isPredicateCheckClause = (clause: CheckClause): clause is PredicateCheckClause =>
  clause.kind === "predicate";

/** Every single-quoted literal in `expression`, in source order, unescaped. */
function collectStringLiterals(expression: string): readonly string[] {
  return [...expression.matchAll(newStringLiteralPattern())].map((match) =>
    (match[1] ?? "").replaceAll("''", "'"),
  );
}

/**
 * Classifies one `CHECK` body into the enum or predicate bucket, throwing on
 * anything else.
 *
 * The discriminator is the presence of `IN (`, not "did my enum regex happen
 * to match": a clause that *looks* like an enum but does not parse cleanly — a
 * bare column reference in the list, a concatenation, a function call wrapping
 * the column — is an error. Classifying it as a predicate would silently drop
 * a vocabulary out of this tripwire's coverage, which is the exact failure
 * this file exists to prevent.
 */
function classifyCheckClause(tableName: string, rawExpression: string): CheckClause {
  const expression = rawExpression.trim();
  const collapsedExpression = expression.replace(/\s+/g, " ");

  if (!CONTAINS_IN_LIST_PATTERN.test(expression)) {
    return {
      kind: "predicate",
      tableName,
      expression: collapsedExpression,
      verbatimExpression: expression,
    };
  }

  const enumMatch = ENUM_CHECK_PATTERN.exec(expression);
  if (enumMatch === null) {
    throw new Error(
      `${tableName}: CHECK clause carries an IN list but does not match <column> IN (<literals>) — refusing to skip it: ${collapsedExpression}`,
    );
  }

  const columnName = enumMatch[1] ?? "";
  const literalList = enumMatch[2] ?? "";
  const values = collectStringLiterals(literalList);
  // Residue check: with every literal removed, a well-formed list leaves only
  // separators behind. Anything else (an identifier, an operator, a nested
  // call) means the parse was partial, and a partial parse of an enum is a
  // wrong vocabulary rather than a missing one.
  const residue = literalList.replace(newStringLiteralPattern(), "");
  const separatorCount = (residue.match(/,/g) ?? []).length;

  if (values.length === 0 || !/^[\s,]*$/.test(residue) || separatorCount !== values.length - 1) {
    throw new Error(
      `${tableName}.${columnName}: CHECK IN list is not a plain comma-separated string-literal list — refusing to skip it: ${collapsedExpression}`,
    );
  }

  return { kind: "enum", tableName, columnName, values };
}

/**
 * Parses the migration SQL into its table census and classified `CHECK`
 * clauses. Every error path throws; nothing is skipped.
 */
function extractMigrationChecks(migrationSql: string): ExtractedMigration {
  const sql = stripSqlLineComments(migrationSql);
  const tableNames: string[] = [];
  const checkClauses: CheckClause[] = [];

  const createTablePattern = newCreateTableStartPattern();
  let tableMatch = createTablePattern.exec(sql);

  while (tableMatch !== null) {
    const tableName = tableMatch[1] ?? "";
    const bodyOpenIndex = tableMatch.index + tableMatch[0].length - 1;
    const bodyCloseIndex = findMatchingCloseParenIndex(sql, bodyOpenIndex);
    const tableBody = sql.slice(bodyOpenIndex + 1, bodyCloseIndex);

    tableNames.push(tableName);

    const checkKeywordPattern = newCheckKeywordPattern();
    let checkMatch = checkKeywordPattern.exec(tableBody);

    while (checkMatch !== null) {
      const afterKeyword = tableBody.slice(checkMatch.index + checkMatch[0].length);
      const leadingWhitespaceLength = afterKeyword.length - afterKeyword.trimStart().length;
      const checkOpenIndex = checkMatch.index + checkMatch[0].length + leadingWhitespaceLength;

      if (tableBody.charAt(checkOpenIndex) !== "(") {
        throw new Error(
          `${tableName}: CHECK keyword is not followed by a parenthesized expression — refusing to parse it.`,
        );
      }

      const checkCloseIndex = findMatchingCloseParenIndex(tableBody, checkOpenIndex);
      checkClauses.push(
        classifyCheckClause(tableName, tableBody.slice(checkOpenIndex + 1, checkCloseIndex)),
      );

      checkKeywordPattern.lastIndex = checkCloseIndex + 1;
      checkMatch = checkKeywordPattern.exec(tableBody);
    }

    createTablePattern.lastIndex = bodyCloseIndex + 1;
    tableMatch = createTablePattern.exec(sql);
  }

  // Deliberately a SECOND mechanism — a flat keyword scan over the whole
  // comment-stripped statement text, not a byproduct of the walk above. If the
  // walk loses a CREATE TABLE block (or a CHECK inside one), this count still
  // sees the clause and the reconciliation test fails. A reconciliation
  // derived from the same traversal would be vacuous.
  const independentCheckKeywordCount = (sql.match(newCheckKeywordPattern()) ?? []).length;

  return { tableNames, checkClauses, independentCheckKeywordCount };
}

/**
 * The DDL vocabulary for one qualified column. THROWS on a miss — a renamed
 * table or column must surface as a loud failure, never as an empty set that
 * silently conforms to nothing.
 */
function ddlEnumVocabulary(
  extracted: ExtractedMigration,
  qualifiedColumn: string,
): readonly string[] {
  const enumClause = extracted.checkClauses
    .filter(isEnumCheckClause)
    .find((clause) => `${clause.tableName}.${clause.columnName}` === qualifiedColumn);

  if (enumClause === undefined) {
    const extractedColumns = extracted.checkClauses
      .filter(isEnumCheckClause)
      .map((clause) => `${clause.tableName}.${clause.columnName}`);
    throw new Error(
      `No enum CHECK clause found for ${qualifiedColumn} — extracted: [${extractedColumns.join(", ")}]`,
    );
  }

  return enumClause.values;
}

// ---------------------------------------------------------------------------
// Contract-side vocabulary read
// ---------------------------------------------------------------------------

/**
 * Reads a Zod enum's declaration-ordered members.
 *
 * The contract enums are annotated `z.ZodType<T>` (the `isolatedDeclarations`
 * posture), which erases `.options` from the static type while leaving it on
 * the runtime `ZodEnum`. The `as unknown as` view is the same internals cast
 * `contracts/src/__tests__/worktree.test.ts` uses. The guard is the part that
 * matters here: a schema that stops being a `z.enum` yields `undefined`, and
 * `undefined` flowing into a comparison is how a tripwire goes quiet.
 */
function readContractVocabulary(contractSymbol: string, schema: unknown): readonly string[] {
  const schemaInternals = schema as { options?: unknown };
  const options = schemaInternals.options;

  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.some((option) => typeof option !== "string")
  ) {
    throw new Error(
      `${contractSymbol}: expected a non-empty z.enum exposing string .options, got ${JSON.stringify(options)}`,
    );
  }

  return options as readonly string[];
}

// ---------------------------------------------------------------------------
// The comparison path — one function, shared by the real pins and the canaries
// ---------------------------------------------------------------------------

/**
 * `sequence` compares declaration order too; `set` compares membership only
 * (as a sorted multiset, so a duplicated literal is still a mismatch).
 */
type LockstepMode = "sequence" | "set";

/**
 * The SINGLE comparison path. Returns `null` when the two vocabularies are in
 * lockstep, else a detail string naming the disagreement.
 *
 * Verdict-returning rather than assertion-throwing on purpose: the mutation
 * canaries below must exercise THIS function, not a parallel reimplementation
 * of it, or they prove nothing about the assertions that matter. An empty
 * vocabulary on either side is itself a mismatch — the extractor going quiet
 * must never read as conformance.
 */
function lockstepMismatch(
  mode: LockstepMode,
  ddlValues: readonly string[],
  contractValues: readonly string[],
): string | null {
  if (ddlValues.length === 0 || contractValues.length === 0) {
    return `empty vocabulary (ddl=${ddlValues.length}, contract=${contractValues.length}) — extraction or contract read went quiet`;
  }

  const comparableDdlValues = mode === "sequence" ? [...ddlValues] : [...ddlValues].sort();
  const comparableContractValues =
    mode === "sequence" ? [...contractValues] : [...contractValues].sort();

  const conforms =
    comparableDdlValues.length === comparableContractValues.length &&
    comparableDdlValues.every((value, index) => value === comparableContractValues[index]);

  return conforms
    ? null
    : `${mode} mismatch — DDL ${JSON.stringify(ddlValues)} vs contract ${JSON.stringify(contractValues)}`;
}

/**
 * Verdict on `run_execution_contexts`'s two spellings of its own vocabulary:
 * the deduped literals its mode-conditional arms name, against the
 * `execution_mode` enum CHECK. Returns `null` when they agree.
 *
 * Shared by the real assertion and its canary for the same reason
 * `lockstepMismatch` is — a canary comparing through a second implementation
 * proves nothing about the first.
 */
function modeConditionalArmMismatch(extracted: ExtractedMigration): string | null {
  const modeVocabulary = ddlEnumVocabulary(extracted, "run_execution_contexts.execution_mode");
  const modeConditionalPredicate = extracted.checkClauses
    .filter(isPredicateCheckClause)
    .find((clause) => clause.tableName === "run_execution_contexts");

  if (modeConditionalPredicate === undefined) {
    return "run_execution_contexts has no predicate CHECK — the mode-conditional clause vanished";
  }

  // VERBATIM, not the collapsed form: `.expression` normalizes whitespace
  // INSIDE literals too, folding a typo'd `'ephemeral  clone'` back into the
  // valid `'ephemeral clone'` and returning "conforming" for an arm no row can
  // satisfy. Verified as a live silent pass before this read was corrected.
  const armLiterals = [
    ...new Set(collectStringLiterals(modeConditionalPredicate.verbatimExpression)),
  ].sort();
  const sortedVocabulary = [...modeVocabulary].sort();
  const agrees =
    armLiterals.length === sortedVocabulary.length &&
    armLiterals.every((literal, index) => literal === sortedVocabulary[index]);

  return agrees
    ? null
    : `mode-conditional arms name ${JSON.stringify(armLiterals)} but execution_mode admits ${JSON.stringify(sortedVocabulary)}`;
}

// ---------------------------------------------------------------------------
// The four pinned clauses
// ---------------------------------------------------------------------------

interface LockstepRow {
  readonly qualifiedColumn: string;
  readonly contractSymbol: string;
  /**
   * Typed `unknown`: the four schemas have distinct output types, so a typed
   * element would widen the array — and `.options` is erased from all four
   * static types anyway (`readContractVocabulary` is the guarded reader).
   */
  readonly schema: unknown;
  readonly mode: LockstepMode;
  readonly expectedSize: number;
}

// FOUR clauses, not the three the plan's T1.4 prose names. The prose
// enumerates the enums `worktree.ts` DECLARES; the migration additionally
// CHECKs `run_execution_contexts.execution_mode`. Leaving that one unpinned
// would let the very drift this tripwire exists to catch through on a quarter
// of the surface, so it is covered here — under a different comparison mode.
//
// ON THE PLAN'S "SETS" WORDING — read this before concluding the table below
// contradicts its governing doc. The T1.4 row in
// `docs/plans/010-worktree-lifecycle-and-execution-modes.md` says this test
// "Asserts the `WorktreeState`/`EphemeralCloneState`/cleanup-policy literal
// sets in `worktree.ts` equal the sets parsed out of the migration's CHECK
// clauses" — quoted verbatim; every emphasis below is this file's, not the
// plan's — while T1.1's `worktree.ts` §Canonical enums banner says its
// declaration order mirrors those same CHECK clauses byte-for-byte and hands
// this test "an ORDERED target". Those look like they disagree; they do not,
// once split by OWNERSHIP — and the split is what the `mode` column encodes:
//
//   * Both sides Plan-010-owned  -> sequence. The plan's "sets" is the loose
//     description of the goal (one vocabulary, not two); the contract file
//     makes a strictly STRONGER, explicit ordering claim about the same pair
//     of surfaces. A documented claim with no check behind it is an open
//     drift class, and set equality would leave it open. Ordering is also not
//     merely a local convention: a reorder on one side alone desyncs from the
//     ratified DDL in
//     `docs/architecture/schemas/local-sqlite-schema.md §Workspace and Git Tables (Plan-009, Plan-010, Plan-011)`,
//     so this test firing is correct behavior rather than a false positive.
//   * Sides owned by DIFFERENT plans -> set. See the `execution_mode` row.
//
// Set equality on all four was the alternative; it matches the plan's wording
// literally and would have been the lower-friction read. It was rejected
// because it silently drops the one claim the contract file actually makes.
//
// ORDER IS LOAD-BEARING IN THIS ARRAY, for a second and unrelated reason: the
// census test asserts the extracted enum clauses appear in exactly this
// sequence, so these rows are also the expected MIGRATION order (D-010-5), the
// same contract `EXPECTED_TABLE_NAMES` states for tables. A fifth enum CHECK
// must be INSERTED at its migration position, not appended — appending fails
// the census with a message that reads like drift when it is bookkeeping.
const LOCKSTEP_ROWS: readonly LockstepRow[] = [
  // ORDERED — the three Plan-010-owned vocabularies. INTRA-PLAN OWNERSHIP is
  // the reason: this plan owns both the contract enum and the CHECK clause, so
  // pinning order costs no other plan anything and keeps the pair editable
  // only in lockstep. `worktree.ts`'s §Canonical enums banner claims its
  // declaration order mirrors the ratified CHECK clauses byte-for-byte, and
  // I-010-2's lockstep is what makes that claim enforceable rather than
  // decorative. Both sides were read when this test landed and agreed
  // member-for-member and order-for-order; a reorder on either side is a
  // deliberate, paired edit — and a wire non-event either way (RFC 8785 JCS
  // serializes the literal), which is exactly why only a test can catch it.
  {
    qualifiedColumn: "worktrees.state",
    contractSymbol: "WorktreeStateSchema",
    schema: WorktreeStateSchema,
    mode: "sequence",
    expectedSize: 6,
  },
  {
    qualifiedColumn: "ephemeral_clones.cleanup_policy",
    contractSymbol: "CleanupPolicySchema",
    schema: CleanupPolicySchema,
    mode: "sequence",
    expectedSize: 2,
  },
  {
    qualifiedColumn: "ephemeral_clones.state",
    contractSymbol: "EphemeralCloneStateSchema",
    schema: EphemeralCloneStateSchema,
    mode: "sequence",
    expectedSize: 4,
  },
  // UNORDERED, and deliberately NOT sequence-compared even though it would
  // pass today. `ExecutionModeSchema` is declared in `repo.ts` and owned by
  // Plan-009, not Plan-010; its declaration order happens to match this
  // migration's CHECK clause right now (`read-only, branch, worktree,
  // ephemeral clone` in both), so an ordered pin would look correct and be
  // wrong. A future Plan-009 reorder is a non-event on the wire — RFC 8785 JCS
  // serializes the literal string, and ADR-018 §Decision #8 makes only
  // additions (MINOR) and removals (MAJOR) version events — so an ordered pin
  // would convert a Plan-009 non-event into a spurious Plan-010 failure,
  // coupling another plan's declaration order to our DDL. Set equality is the
  // honest contract for a vocabulary this plan consumes rather than owns.
  {
    qualifiedColumn: "run_execution_contexts.execution_mode",
    contractSymbol: "ExecutionModeSchema",
    schema: ExecutionModeSchema,
    mode: "set",
    expectedSize: 4,
  },
];

/** The four Plan-010 tables, in migration order (D-010-5). */
const EXPECTED_TABLE_NAMES: readonly string[] = [
  "worktrees",
  "ephemeral_clones",
  "branch_contexts",
  "run_execution_contexts",
];

/**
 * The two non-enum CHECKs: `branch_contexts`'s at-most-one-root clause
 * (I-010-5) and `run_execution_contexts`'s mode-conditional clause (D-010-5).
 * Their behavior is `migration-shape.test.ts`'s concern; what is pinned here
 * is that the extractor SEES them — a swallowed predicate would corrupt the
 * census that guards the four enum clauses.
 */
const EXPECTED_PREDICATE_TABLES: readonly string[] = ["branch_contexts", "run_execution_contexts"];

const EXPECTED_TOTAL_CHECK_COUNT: number = LOCKSTEP_ROWS.length + EXPECTED_PREDICATE_TABLES.length;

function extractRatifiedMigration(): ExtractedMigration {
  return extractMigrationChecks(WORKTREE_LIFECYCLE_MIGRATION_SQL);
}

// ---------------------------------------------------------------------------
// Fail-closed census over the extraction
// ---------------------------------------------------------------------------

describe("0004-worktree-lifecycle CHECK extraction — fail-closed census", () => {
  it("extracts exactly the four Plan-010 CREATE TABLE blocks, by name", () => {
    // Names, not just a count: a rename would hold the count at four while
    // making every enum lookup for the old name miss.
    expect(extractRatifiedMigration().tableNames).toEqual(EXPECTED_TABLE_NAMES);
  });

  it("extracts exactly six CHECK clauses — four enum, two predicate", () => {
    const extracted = extractRatifiedMigration();
    const enumClauses = extracted.checkClauses.filter(isEnumCheckClause);
    const predicateClauses = extracted.checkClauses.filter(isPredicateCheckClause);

    expect(extracted.checkClauses).toHaveLength(EXPECTED_TOTAL_CHECK_COUNT);
    expect(enumClauses.map((clause) => `${clause.tableName}.${clause.columnName}`)).toEqual(
      LOCKSTEP_ROWS.map((row) => row.qualifiedColumn),
    );
    expect(predicateClauses.map((clause) => clause.tableName)).toEqual(EXPECTED_PREDICATE_TABLES);
    // Seen, not swallowed: each predicate carries real text.
    for (const predicateClause of predicateClauses) {
      expect(predicateClause.expression.length).toBeGreaterThan(0);
    }
  });

  it("reconciles the paren-walk census against an independent whole-SQL keyword count", () => {
    // Two mechanisms disagreeing means a CHECK exists somewhere the walk does
    // not look — the silent-under-count case, caught rather than inherited.
    const extracted = extractRatifiedMigration();
    // LOAD-BEARING, and not the same assertion as the line below it: this one
    // compares against an ABSOLUTE expectation, the one below compares the two
    // extraction-derived counts to each other. Both mechanisms share
    // `stripSqlLineComments`, so a stripper bug drops a CHECK from both and the
    // second assertion still passes at 5 === 5. Only the absolute comparison
    // catches that. Collapsing these two into one deletes the guard silently.
    expect(extracted.independentCheckKeywordCount).toBe(EXPECTED_TOTAL_CHECK_COUNT);
    expect(extracted.checkClauses).toHaveLength(extracted.independentCheckKeywordCount);
  });

  it.each(LOCKSTEP_ROWS)(
    "$qualifiedColumn yields a non-empty vocabulary of the ratified size",
    ({ qualifiedColumn, expectedSize }) => {
      const ddlValues = ddlEnumVocabulary(extractRatifiedMigration(), qualifiedColumn);
      expect(ddlValues.length).toBeGreaterThan(0);
      expect(ddlValues).toHaveLength(expectedSize);
      // No duplicates — a repeated literal would let the sorted-multiset
      // comparison in `set` mode mask a missing member.
      expect(new Set(ddlValues).size).toBe(ddlValues.length);
    },
  );

  it("throws on an enum-shaped CHECK it cannot fully parse, rather than skipping it", () => {
    // A column reference where a literal belongs: the clause still reads as an
    // IN list, so a lenient parser would file it under "predicate" and drop
    // `worktrees.state` out of this tripwire's coverage entirely.
    const mutatedSql = WORKTREE_LIFECYCLE_MIGRATION_SQL.replace(
      "CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed'))",
      "CHECK(state IN ('creating', legacy_state))",
    );
    expect(mutatedSql).not.toBe(WORKTREE_LIFECYCLE_MIGRATION_SQL);

    expect(() => extractMigrationChecks(mutatedSql)).toThrow(
      /worktrees\.state: CHECK IN list is not a plain comma-separated string-literal list/,
    );
  });

  it("counts an added predicate CHECK instead of swallowing it", () => {
    const mutatedSql = WORKTREE_LIFECYCLE_MIGRATION_SQL.replace(
      "  cleaned_at            TEXT ",
      "  cleaned_at            TEXT,\n  CHECK (created_at <= updated_at) ",
    );
    expect(mutatedSql).not.toBe(WORKTREE_LIFECYCLE_MIGRATION_SQL);

    const extracted = extractMigrationChecks(mutatedSql);
    expect(extracted.checkClauses).toHaveLength(EXPECTED_TOTAL_CHECK_COUNT + 1);
    expect(extracted.independentCheckKeywordCount).toBe(EXPECTED_TOTAL_CHECK_COUNT + 1);
  });

  it("throws when an enum lookup misses, rather than returning an empty set", () => {
    // The renamed-table / renamed-column case. An empty return here is exactly
    // the empty-vs-empty pass this whole file is built to prevent.
    expect(() => ddlEnumVocabulary(extractRatifiedMigration(), "worktrees.status")).toThrow(
      /No enum CHECK clause found for worktrees\.status/,
    );
  });

  it("refuses a migration string with an unterminated literal", () => {
    expect(() => extractMigrationChecks("CREATE TABLE t (state TEXT DEFAULT 'creating);")).toThrow(
      /unterminated string literal/,
    );
  });
});

// ---------------------------------------------------------------------------
// The lockstep assertions (I-010-2)
// ---------------------------------------------------------------------------

describe("contract↔DDL lockstep (I-010-2)", () => {
  // THREE OF FOUR ARE ORDER-PINNED, one is not, and the `mode` column of
  // `LOCKSTEP_ROWS` carries the per-row reason at each row. The short version,
  // repeated here because this is where a reviewer comparing the test against
  // the plan's "literal sets" wording lands first:
  //
  //   * `worktrees.state`, `ephemeral_clones.cleanup_policy`,
  //     `ephemeral_clones.state` -> SEQUENCE. Plan-010 owns both sides, and
  //     `worktree.ts` explicitly claims byte-for-byte order mirroring of these
  //     CHECK clauses. Set equality would leave that claim unchecked.
  //   * `run_execution_contexts.execution_mode` -> SET. `ExecutionModeSchema`
  //     is Plan-009-owned; ordering it would couple another plan's declaration
  //     order to this plan's DDL.
  //
  // The plan's "sets" phrasing describes the goal, not the comparison
  // operator; the ownership split above is the reconciliation. Full argument
  // in the banner over `LOCKSTEP_ROWS`.
  it.each(LOCKSTEP_ROWS)(
    "$qualifiedColumn is in $mode lockstep with $contractSymbol",
    ({ qualifiedColumn, contractSymbol, schema, mode }) => {
      const ddlValues = ddlEnumVocabulary(extractRatifiedMigration(), qualifiedColumn);
      const contractValues = readContractVocabulary(contractSymbol, schema);

      expect(lockstepMismatch(mode, ddlValues, contractValues)).toBeNull();
    },
  );

  it("mode-conditional arm literals are set-EQUAL to the execution_mode vocabulary", () => {
    // `run_execution_contexts` spells its four modes TWICE — once in the enum
    // CHECK, once per arm of the mode-conditional CHECK. EQUALITY, not
    // containment, is the assertion, and the title says so: every mode needs an
    // arm AND no arm may name a non-mode. A maintainer weakening this to a
    // subset check would satisfy a containment-worded title while dropping half
    // the coverage.
    //
    // The direction unique to this file is the DEAD ARM: a stale
    // `OR (execution_mode = 'detached' AND …)` naming a mode the enum no longer
    // admits. No row can ever reach that arm, so every accept/reject test still
    // passes; only the deduped-set count going 5 ≠ 4 catches it.
    //
    // The opposite direction — a typo'd arm like `'ephemeral-clone'` for
    // `'ephemeral clone'` — is NOT unique to this file, and an earlier version
    // of this comment wrongly claimed it was. `migration-shape.test.ts`'s
    // "accepts one in-shape run_execution_contexts row per execution mode"
    // inserts one accepting row per arm, including an `"ephemeral clone"` row
    // under `.not.toThrow()`; any accept of a mode-typed row must satisfy this
    // CHECK, so a typo'd arm fails there too.
    // Set equality covers both directions, which is why the assertion stays.
    expect(modeConditionalArmMismatch(extractRatifiedMigration())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutation canaries — proof the comparison can trip
// ---------------------------------------------------------------------------

describe("mutation canaries — the tripwire can actually trip", () => {
  it("catches a substituted DDL literal through the full extract→compare path", () => {
    // Whole pipeline, not just the comparator: strip → walk → classify →
    // compare. A canary that skipped the extractor would not prove the
    // extractor still matches the real SQL.
    const mutatedSql = WORKTREE_LIFECYCLE_MIGRATION_SQL.replace("'dirty'", "'soiled'");
    expect(mutatedSql).not.toBe(WORKTREE_LIFECYCLE_MIGRATION_SQL);

    const mismatch = lockstepMismatch(
      "sequence",
      ddlEnumVocabulary(extractMigrationChecks(mutatedSql), "worktrees.state"),
      readContractVocabulary("WorktreeStateSchema", WorktreeStateSchema),
    );

    expect(mismatch).not.toBeNull();
    expect(mismatch).toContain("soiled");
  });

  it("catches a DDL literal added without the paired contract edit", () => {
    const mutatedSql = WORKTREE_LIFECYCLE_MIGRATION_SQL.replace(
      "CHECK(cleanup_policy IN ('on_run_complete', 'manual'))",
      "CHECK(cleanup_policy IN ('on_run_complete', 'manual', 'on_session_end'))",
    );
    expect(mutatedSql).not.toBe(WORKTREE_LIFECYCLE_MIGRATION_SQL);

    const mismatch = lockstepMismatch(
      "sequence",
      ddlEnumVocabulary(extractMigrationChecks(mutatedSql), "ephemeral_clones.cleanup_policy"),
      readContractVocabulary("CleanupPolicySchema", CleanupPolicySchema),
    );

    expect(mismatch).not.toBeNull();
    expect(mismatch).toContain("on_session_end");
  });

  it.each(LOCKSTEP_ROWS)(
    "$qualifiedColumn: a corrupted contract vocabulary fails the same comparison that just passed",
    ({ qualifiedColumn, contractSymbol, schema, mode }) => {
      const ddlValues = ddlEnumVocabulary(extractRatifiedMigration(), qualifiedColumn);
      const contractValues = readContractVocabulary(contractSymbol, schema);
      const lastContractValue = contractValues[contractValues.length - 1] ?? "";
      const corruptedContractValues = [
        ...contractValues.slice(0, -1),
        `${lastContractValue}-corrupted`,
      ];

      // Same inputs, same function — only the last member differs. This is the
      // row-by-row proof that the passing assertion in the block above is
      // load-bearing rather than vacuously true for this particular pair.
      expect(lockstepMismatch(mode, ddlValues, contractValues)).toBeNull();
      expect(lockstepMismatch(mode, ddlValues, corruptedContractValues)).not.toBeNull();
    },
  );

  it("sequence mode rejects a pure reorder", () => {
    const ddlValues = ddlEnumVocabulary(extractRatifiedMigration(), "worktrees.state");
    const reorderedValues = [...ddlValues].reverse();

    expect(lockstepMismatch("sequence", ddlValues, reorderedValues)).not.toBeNull();
  });

  it("set mode accepts a pure reorder but still rejects a membership change", () => {
    // The deliberate asymmetry, executable. The execution-mode vocabulary is
    // Plan-009-owned, so a reorder there is a non-event this test must NOT
    // fail on — while a dropped or renamed member stays a hard failure.
    const ddlValues = ddlEnumVocabulary(
      extractRatifiedMigration(),
      "run_execution_contexts.execution_mode",
    );
    const reorderedValues = [...ddlValues].reverse();
    const memberChangedValues = [...ddlValues.slice(0, -1), "ephemeral-clone"];

    expect(lockstepMismatch("set", ddlValues, reorderedValues)).toBeNull();
    expect(lockstepMismatch("sequence", ddlValues, reorderedValues)).not.toBeNull();
    expect(lockstepMismatch("set", ddlValues, memberChangedValues)).not.toBeNull();
  });

  it("refuses to call an empty-vs-empty comparison conforming", () => {
    // The terminal failure mode: extraction stops matching, both sides go
    // empty, and a naive deep-equal reports lockstep forever.
    expect(lockstepMismatch("sequence", [], [])).not.toBeNull();
    expect(lockstepMismatch("set", [], [])).not.toBeNull();
    expect(lockstepMismatch("set", [], ["worktree"])).not.toBeNull();
  });

  it("catches a double-spaced arm literal that whitespace collapse would hide", () => {
    // The one member whose spelling contains a space (`ephemeral clone`) is the
    // one whose typo a normalizing comparison silently forgives. Targeted at
    // the ARM only — `= 'ephemeral clone' AND` appears once, in the predicate;
    // the enum CHECK spells it `'ephemeral clone'))`, so the enum side stays
    // correct and the two spellings genuinely disagree.
    const mutatedSql = WORKTREE_LIFECYCLE_MIGRATION_SQL.replace(
      "= 'ephemeral clone' AND",
      "= 'ephemeral  clone' AND",
    );
    expect(mutatedSql).not.toBe(WORKTREE_LIFECYCLE_MIGRATION_SQL);
    // Exactly one arm perturbed, and the enum CHECK untouched.
    expect(mutatedSql).toContain("CHECK(execution_mode IN ('read-only', 'branch', 'worktree',");
    expect(mutatedSql).toContain("'ephemeral clone'))");

    const mismatch = modeConditionalArmMismatch(extractMigrationChecks(mutatedSql));
    expect(mismatch).not.toBeNull();
    expect(mismatch).toContain("ephemeral  clone");
  });

  it("parses a doubled-quote escape into a single apostrophe", () => {
    // `''` handling exists in all three scanners but no literal in the current
    // migration exercises it, so it is asserted here rather than assumed — the
    // standard the header sets for every other guard in this file.
    const extracted = extractMigrationChecks(
      "CREATE TABLE t (state TEXT CHECK(state IN ('it''s', 'ready')));",
    );
    const enumClauses = extracted.checkClauses.filter(isEnumCheckClause);

    expect(enumClauses).toHaveLength(1);
    expect(enumClauses[0]?.values).toEqual(["it's", "ready"]);
  });

  it("rejects a contract schema that stopped exposing enum options", () => {
    expect(() => readContractVocabulary("NotAnEnumSchema", {})).toThrow(
      /expected a non-empty z\.enum exposing string \.options/,
    );
    expect(() => readContractVocabulary("EmptyEnumSchema", { options: [] })).toThrow(
      /expected a non-empty z\.enum exposing string \.options/,
    );
  });
});
