/**
 * Signal derivation for the Codex review gate: raw GitHub payloads (reviews, reactions, comments,
 * review threads, check suites) turned into the signals codex-verdict.mjs decides on.
 */

/**
 * The bot's login, which splits by API surface rather than by data type.
 *
 * Every REST endpoint — reactions, issue comments and `pulls/N/reviews` — returns
 * it with the `[bot]` suffix; every GraphQL author field returns it without,
 * because GraphQL's `Bot.login` carries none. A wrong-form filter silently
 * matches zero rows and the poll never terminates.
 */
export const BOT_REST_LOGIN = "chatgpt-codex-connector[bot]";
export const BOT_GRAPHQL_LOGIN = "chatgpt-codex-connector";

/**
 * The CODE-review quota notice only, deliberately narrower than a bare "usage limits".
 *
 * The bot runs two reviewers off separate quotas and reports both through the
 * same comment surface, so a security-review limit notice can sit beside a code
 * review that finished with findings. Only the code-review quota stops the review
 * this gate polls for, so only that text may terminate the poll. A generic limit
 * body without "for code reviews" does not match, so the gate polls to its
 * timeout on it: a slow miss rather than a wrong terminal.
 */
const RATE_LIMIT_PATTERN = /usage limits for code reviews/i;

/**
 * The clean verdict Codex posts as a comment: "Codex Review: Didn't find any major issues."
 *
 * Codex sends an ASCII apostrophe; U+2019 is accepted too, because a
 * typographic-quote swap upstream would otherwise match zero comments silently,
 * the same class of break as a wrong-form `[bot]` login.
 */
const CLEAN_VERDICT_PATTERN = /Didn['’]t find any major issues/i;

/**
 * The `**Reviewed commit:** \`<sha10>\`` line Codex attaches to a review comment.
 *
 * Read in BOTH directions, which is why it is hoisted to a shared const. Paired
 * with the head sha it is an ack anchor no timestamp can stale
 * (`shaCitingComments`); paired with any OTHER sha it is the opposite — positive
 * evidence that the comment is a verdict on a commit that is not HEAD
 * (`deriveStaleRunEvidence`). One pattern, so the two readings can never drift
 * apart on a format change.
 */
const REVIEWED_COMMIT_PATTERN = /Reviewed commit/i;

/**
 * The sha out of that line, for the diagnostic only — never for a decision.
 *
 * `[^0-9a-f]*` skips the `:** \`` punctuation between the label and the sha. A
 * format change that defeats it yields no capture, and every caller degrades to
 * naming no sha rather than to a wrong one: nothing branches on this.
 */
const REVIEWED_COMMIT_SHA_PATTERN = /Reviewed commit[^0-9a-f]*([0-9a-f]{7,40})/i;

/**
 * A findings pass delivered as a COMMENT body instead of as inline threads.
 *
 * Codex reports findings two ways. Besides a review with inline threads, it can
 * post a `### 💡 Codex Review` comment carrying the findings themselves (severity
 * badge, permalink, prose) with no thread, no `Reviewed commit:` line and no
 * clean verdict. No other ack leg matches that comment, so without this pattern
 * the gate would report `no_ack_yet` about a commit Codex had reviewed and filed
 * findings against.
 *
 * Two markers, either sufficient, because they fail independently: an upstream
 * emoji change kills the heading, a severity-scheme change kills the badge.
 * Accepting either is the fail-closed direction, since the failure guarded is a
 * findings comment going unseen. Neither marker appears on a clean verdict or a
 * usage-limits notice. The permalink is deliberately not a marker, because a
 * conversational reply from the bot can carry one too.
 */
const FINDINGS_SUMMARY_PATTERN = /###\s*.{0,4}\s*Codex Review|!\[P\d+ Badge\]/u;

/**
 * The instant an ack must post-date, given the HEAD commit and its check suites.
 *
 * The commit timestamp is the wrong anchor on its own: it is the LOCAL commit
 * time, written by the author's clock, so every second between committing and
 * pushing is a window in which a `+1` for the PREVIOUS head lands carrying a
 * `created_at` that still beats it, and acks a commit Codex never saw. A
 * commit-then-verify-then-push workflow widens that window to minutes.
 *
 * GitHub does not populate `Commit.pushedDate`, so the earliest
 * `check_suite.created_at` for the sha is the closest server-side observation of
 * the push: GitHub creates a suite per installed app on receiving it. Check
 * suites beat `actions/runs` because they cover non-Actions apps too.
 *
 * This is the FALLBACK floor. The primary one is `observeBaseline` in
 * `lib/observation-baseline.mjs`, the gate's own first sighting of the sha as
 * this PR's HEAD, which the caller uses whenever it is available.
 *
 * Combined with `max`, so the anchor never moves earlier than the commit time,
 * and the caller joins the baseline to the same `max`, so no floor found here is
 * given back. Three residuals of this path:
 *   - a sha pushed earlier on another branch carries that earlier suite, so this
 *     is the first moment the sha was visible anywhere in the repo, not the
 *     moment it became this PR's head. The observation baseline closes that; a
 *     run with no usable baseline is refused a timestamp-only merge on a
 *     separate conjunct rather than leaning on this bound.
 *   - a suite timestamp in the future (clock skew) pins the anchor ahead of
 *     every ack, and the gate reports `no_ack_yet` until wall-clock catches up.
 *     That is the fail-closed direction, and the caller prints the anchor it
 *     chose and which source won, so the cause is legible.
 *   - suite creation and Codex's webhook are independent consumers of the same
 *     push, so a `+1` posted before the earliest suite is rejected. That does not
 *     strand the gate, because Codex's passes also carry a sha-bound leg no
 *     timestamp can stale: a findings pass posts a review whose `commit_id` is
 *     HEAD, and a clean pass posts one comment that is both the clean verdict and
 *     a `Reviewed commit:` citation, which `deriveCommentSignals` matches on the
 *     sha. A clean pass usually posts no review on HEAD, so the review leg does
 *     not carry that case. Only a bare `+1` with neither would strand the gate,
 *     and `no_ack_yet` prints the `@codex review` re-trigger, whose fresh ack
 *     post-dates the anchor. The comment leg recovers one settle window late,
 *     since it sits inside that window.
 *
 * @param {number} committedAtMs
 * @param {Array<object>} checkSuites Raw `check_suites` rows for the head sha.
 * @returns {{anchorMs: number, pushObservedAtMs: number | null, pushAnchorKnown: boolean}}
 */
export function derivePushAnchor(committedAtMs, checkSuites) {
  let earliestMs = null;
  for (const suite of checkSuites ?? []) {
    const createdMs = new Date(suite?.created_at ?? Number.NaN).getTime();
    if (!Number.isFinite(createdMs)) continue;
    if (earliestMs === null || createdMs < earliestMs) earliestMs = createdMs;
  }
  return {
    anchorMs: earliestMs === null ? committedAtMs : Math.max(committedAtMs, earliestMs),
    pushObservedAtMs: earliestMs,
    pushAnchorKnown: earliestMs !== null,
  };
}

/**
 * The freshness predicate every timestamp-bound leg uses: `created_at >= anchor`.
 *
 * Inclusive, not strict. GitHub timestamps are second-granular, so an ack posted
 * inside the anchor's own second carries an identical `created_at`; a strict `>`
 * would discard it and leave the poll waiting on an ack that had already landed.
 * An absent or unparseable stamp yields NaN, which compares false: fail closed.
 *
 * @param {string | null | undefined} timestamp
 * @param {number} anchorMs Ack anchor from `derivePushAnchor`, epoch ms.
 * @returns {boolean}
 */
export function isAtOrAfter(timestamp, anchorMs) {
  return new Date(timestamp ?? Number.NaN).getTime() >= anchorMs;
}

/**
 * The newest review by submission time, rather than by array position.
 *
 * Picking by position would trust that the reviews endpoint returns ascending
 * submission order and that the page merge preserves it, the same hazard
 * `selectNewestRunPerName` handles on the CI side. Callers pre-filter to the
 * HEAD-matching set, so ordering does not decide whether an ack exists, but it
 * does decide which review's age feeds the settle window.
 *
 * A tie, or a payload carrying no `submitted_at` at all, keeps the later array
 * position — so the degenerate case falls back to the documented order instead
 * of to an arbitrary pick.
 *
 * @param {Array<object>} reviews
 * @returns {object | null}
 */
export function selectNewestReview(reviews) {
  let newest = null;
  let newestSubmittedMs = Number.NEGATIVE_INFINITY;
  for (const review of reviews ?? []) {
    const submittedMs = new Date(review.submitted_at ?? Number.NaN).getTime();
    const comparable = Number.isNaN(submittedMs) ? Number.NEGATIVE_INFINITY : submittedMs;
    if (newest === null || comparable >= newestSubmittedMs) {
      newest = review;
      newestSubmittedMs = comparable;
    }
  }
  return newest;
}

/**
 * The review ack leg: a bot review whose `.commit_id` is HEAD.
 *
 * Filtered to HEAD BEFORE the newest is picked, never after. Taking the newest
 * bot review globally and then testing its `commit_id` reports no ack whenever
 * two review runs overlap and the one started on the OLDER head submits last,
 * while a review naming HEAD sits in the same payload; it would also feed the
 * settle window the age of the review just rejected.
 *
 * Intrinsically HEAD-bound, so the ack anchor never reaches this leg. Its one
 * timestamp, `latestReviewAgeMs`, is wall-clock relative and belongs to the
 * newest HEAD-matching review, and `computeVerdict` folds it into the settle
 * window only while `reviewAcksHead` holds.
 *
 * That age keeps two cases apart. NO HEAD-matching review means the leg did not
 * fire, and Infinity is right: a leg with no standing must not shorten the
 * settle window. A HEAD-matching review with no usable `submitted_at` DID fire
 * and its recency is unknown; Infinity there would read as "comfortably
 * settled" and allow a merge inside the window, so it reports age 0 instead: an
 * ack you cannot date is treated as one that just landed.
 *
 * The call site must paginate: the reviews endpoint pages at 30, and on a
 * many-round PR the newest review rolls onto a later page, where an unpaginated
 * read returns a permanently stale review.
 *
 * @param {Array<object>} reviews Every review on the PR.
 * @param {string} headSha
 * @param {number} nowMs
 */
export function deriveReviewAck(reviews, headSha, nowMs) {
  const botReviews = (reviews ?? []).filter((review) => review.user?.login === BOT_REST_LOGIN);
  // An absent headSha must match nothing. Filtering on equality alone would let
  // `undefined === undefined` pair a review carrying no `commit_id` with a head
  // the caller never established — an ack invented out of two missing fields,
  // and the fail-OPEN direction.
  const headBotReviews = headSha ? botReviews.filter((review) => review.commit_id === headSha) : [];
  const latestHeadReview = selectNewestReview(headBotReviews);
  // Measured before it is clamped, because the clamp is lossy: 0 is also a real
  // measurement (stamps are second-granular, so an ack read inside its own
  // second measures 0), and the caller has to tell "just landed" from "cannot be
  // dated at all" to print a remediation that can actually work.
  const measuredAgeMs =
    latestHeadReview === null
      ? null
      : nowMs - new Date(latestHeadReview.submitted_at ?? Number.NaN).getTime();
  return {
    botReviews,
    headBotReviews,
    latestHeadReview,
    reviewAcksHead: latestHeadReview !== null,
    latestReviewAgeMs:
      latestHeadReview === null ? Number.POSITIVE_INFINITY : firingLegAgeMs(measuredAgeMs),
    latestReviewAgeUnknown: latestHeadReview !== null && !Number.isFinite(measuredAgeMs),
  };
}

/**
 * The reaction ack leg: a bot `+1` on the PR issue, at or after the ack anchor.
 *
 * Reactions carry no commit reference, so the timestamp is the only thing
 * binding one to the current HEAD; without it a stale `+1` from an earlier push
 * would ack the new head.
 *
 * @param {Array<object>} reactions
 * @param {number} ackAnchorMs From `derivePushAnchor`, NOT the commit time alone.
 */
export function deriveReactionAck(reactions, ackAnchorMs) {
  const botThumbsUp = (reactions ?? []).filter(
    (reaction) => reaction.user?.login === BOT_REST_LOGIN && reaction.content === "+1",
  );
  const freshThumbsUp = botThumbsUp.filter((reaction) =>
    isAtOrAfter(reaction.created_at, ackAnchorMs),
  );
  return { botThumbsUp, freshThumbsUp, reactionAcksHead: freshThumbsUp.length > 0 };
}

/**
 * Wall-clock age of the newest row in a set.
 *
 * The two ways this can fail to produce a number mean OPPOSITE things and get
 * opposite answers — see `firingLegAgeMs` for the full argument. An EMPTY set is
 * a leg that did not fire, and Infinity keeps it from shortening a settle window
 * it has no standing in. A NON-empty set that yields no usable age — every
 * `created_at` unparseable, a missing `nowMs`, or arithmetic on either — is a
 * leg that DID fire whose recency is unknown, and unknown recency is not
 * evidence of age: Infinity there would let an undatable ack read as
 * "comfortably settled" and merge inside the window.
 *
 * `ageUnknown` rides alongside because the clamp is lossy in the direction the
 * caller cares about: 0 is also a real measurement, so a consumer that only sees
 * the number cannot tell "landed this second" from "cannot be dated", and those
 * two want different remediations — one clears itself by waiting and the other
 * never does.
 *
 * @param {Array<object>} rows
 * @param {number} nowMs
 * @returns {{ageMs: number, ageUnknown: boolean}}
 */
function newestCreatedAge(rows, nowMs) {
  if (rows.length === 0) return { ageMs: Number.POSITIVE_INFINITY, ageUnknown: false };
  let newestCreatedMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const createdMs = new Date(row.created_at ?? Number.NaN).getTime();
    if (Number.isFinite(createdMs) && createdMs > newestCreatedMs) newestCreatedMs = createdMs;
  }
  const measuredAgeMs = nowMs - newestCreatedMs;
  return { ageMs: firingLegAgeMs(measuredAgeMs), ageUnknown: !Number.isFinite(measuredAgeMs) };
}

/**
 * Whether a comment body names the head commit by its short sha.
 *
 * An absent or empty `headShaShort` names nothing. `"anything".includes("")` is
 * true, so an unset head would otherwise turn EVERY bot comment into a sha
 * citation — an ack invented out of a missing field, the same fail-OPEN that
 * `deriveReviewAck` guards on the review side. Callers that read a match as
 * suspicion rather than acceptance negate this, so there an absent head makes
 * every citation suspect, which is their fail-closed direction.
 */
function bodyNamesHead(body, headShaShort) {
  return Boolean(headShaShort) && body?.includes(headShaShort) === true;
}

/**
 * Comment-borne signals: three ack legs, a separate cleanliness assertion, a
 * separate findings assertion, and the usage-limits non-ack.
 *
 * The three ack legs are bound to HEAD by DIFFERENT anchors and must not be
 * collapsed. A comment carrying `**Reviewed commit:** \`<sha10>\`` names the
 * commit it reviewed, so the sha IS the anchor and no timestamp filter applies.
 * A findings summary is bound the same way, by the sha in its permalinks. The
 * clean-verdict comment carries no sha at all, so `created_at >= ackAnchorMs`
 * is the only thing tying it to the current push.
 *
 * "Acks HEAD" and "asserts HEAD is clean" are also kept apart. Citing a sha
 * proves only that Codex looked at this commit, not what it found: a
 * findings-bearing comment naming HEAD, read before its inline threads
 * materialize, would otherwise be an ack with zero open threads and score
 * `ack_clean`. `commentAssertsClean` is the narrower fact — a comment that both
 * names this commit and declares it clean, or a clean verdict fresh enough to
 * belong to this push.
 *
 * `commentReportsFindings` is the opposite-signed narrow fact, and it is not the
 * negation of the other: most comments assert neither. It says the body carries
 * findings for THIS commit, which lets the caller tell "Codex reviewed this and
 * its findings are in a comment" from "Codex has not looked yet", two states
 * that demand opposite next actions.
 *
 * `latestCommentAckAgeMs` is the age of the NEWEST acking comment, and newest
 * rather than oldest is the conservative pick: the most recent ack is the one
 * whose threads are likeliest still in flight.
 *
 * The usage-limits non-ack takes a freshness binding too: `rate_limited`
 * outranks every ack leg in computeVerdict, so an unbounded scan would let one
 * old usage-limits comment pin the gate to `rate_limited` even after a later
 * HEAD collected a valid clean ack.
 *
 * It does NOT take the ack floor, which is why the two anchors are separate
 * parameters. "Codex is out of quota" is not a claim about any commit, so it
 * needs only recency, not attribution to HEAD. The observation baseline raises
 * the ack floor above the push, and a genuine notice posted before the gate
 * first ran would fall below it, leaving the gate to report `no_ack_yet` —
 * "keep waiting" — where waiting cannot help. `freshnessAnchorMs` defaults to
 * `ackAnchorMs` for a caller that has only one floor.
 *
 * @param {Array<object>} comments
 * @param {{headShaShort: string, ackAnchorMs: number, freshnessAnchorMs?: number,
 *   nowMs: number}} anchors
 */
export function deriveCommentSignals(
  comments,
  { headShaShort, ackAnchorMs, freshnessAnchorMs = ackAnchorMs, nowMs },
) {
  const botComments = (comments ?? []).filter((comment) => comment.user?.login === BOT_REST_LOGIN);
  const shaCitingComments = botComments.filter(
    (comment) =>
      bodyNamesHead(comment.body, headShaShort) && REVIEWED_COMMIT_PATTERN.test(comment.body ?? ""),
  );
  // A `Reviewed commit:` line that does NOT name HEAD. The comment says which
  // commit it read and it is not this one — so it is a verdict on a different
  // commit no matter how fresh its timestamp is.
  const citesOtherCommit = (body) =>
    REVIEWED_COMMIT_PATTERN.test(body ?? "") && !bodyNamesHead(body, headShaShort);
  const cleanVerdictComments = botComments.filter((comment) =>
    CLEAN_VERDICT_PATTERN.test(comment.body ?? ""),
  );
  // A Codex run for the PREVIOUS head that overlaps a push and finishes
  // afterwards posts its clean verdict with a `created_at` LATER than the new
  // head's anchor, so a timestamp-only predicate would accept it for a commit
  // Codex never read. Moving the anchor cannot separate the two, because the
  // stale ack arrives after the push, so the separator has to be something
  // other than time.
  //
  // The clean comment names the commit it reviewed, so a clean verdict naming a
  // DIFFERENT commit is refused. That is a positive test on the comment's own
  // words, not a sha REQUIREMENT: Codex has posted sha-less clean verdicts too,
  // and a predicate keyed to an external party's wording has to degrade when
  // the wording changes rather than depend on it.
  const otherCommitCleanVerdictComments = cleanVerdictComments.filter((comment) =>
    citesOtherCommit(comment.body),
  );
  const freshCleanVerdictComments = cleanVerdictComments.filter(
    (comment) => !citesOtherCommit(comment.body) && isAtOrAfter(comment.created_at, ackAnchorMs),
  );
  // Sha-cited AND clean: asserts cleanliness with no timestamp involved, which
  // is what keeps an escape hatch open when the push anchor is wrong.
  const cleanVerdictShaComments = shaCitingComments.filter((comment) =>
    CLEAN_VERDICT_PATTERN.test(comment.body ?? ""),
  );
  // Findings in a comment body bind to HEAD by the sha their permalinks carry,
  // with no timestamp involved — the same anchoring `shaCitingComments` uses, and
  // the same shape: the 10-char head prefix appearing anywhere in the body, a
  // substring test rather than an equality one, so a permalink to any commit
  // sharing those 10 hex chars matches too. That is git's own abbreviation width,
  // and a collision inside one PR's comments is not a practical risk. Binding to
  // the sha at all is the point: a summary naming an OLDER sha is findings against
  // a commit that has since been rewritten, for example when the author pushed
  // just before the summary landed, and firing on it would pin the gate to a
  // stale verdict forever.
  const findingsShaComments = botComments.filter(
    (comment) =>
      FINDINGS_SUMMARY_PATTERN.test(comment.body ?? "") &&
      bodyNamesHead(comment.body, headShaShort),
  );
  // `freshnessAnchorMs`, not `ackAnchorMs` — see the parameter note above. This
  // is a recency question about the bot's quota, not an attribution question
  // about a commit.
  const freshRateLimitComments = botComments.filter(
    (comment) =>
      RATE_LIMIT_PATTERN.test(comment.body ?? "") &&
      isAtOrAfter(comment.created_at, freshnessAnchorMs),
  );
  const ackComments = [
    ...new Set([...shaCitingComments, ...freshCleanVerdictComments, ...findingsShaComments]),
  ];
  const { ageMs: latestCommentAckAgeMs, ageUnknown: latestCommentAckAgeUnknown } = newestCreatedAge(
    ackComments,
    nowMs,
  );
  return {
    botComments,
    shaCitingComments,
    freshCleanVerdictComments,
    otherCommitCleanVerdictComments,
    cleanVerdictShaComments,
    findingsShaComments,
    freshRateLimitComments,
    ackComments,
    commentAcksHead: ackComments.length > 0,
    // The subset of the comment ack that names the head sha in its own body, so
    // no timestamp is load-bearing in binding it to HEAD. `computeVerdict` needs
    // this separately from `commentAcksHead` because the two sha-less legs — the
    // fresh clean verdict and the `+1` — are the ones a run for the previous
    // head can forge by finishing late, and only a sha-bound ack proves Codex
    // read THIS commit.
    commentAcksHeadBySha: shaCitingComments.length > 0 || findingsShaComments.length > 0,
    commentAssertsClean: cleanVerdictShaComments.length > 0 || freshCleanVerdictComments.length > 0,
    commentReportsFindings: findingsShaComments.length > 0,
    latestCommentAckAgeMs,
    latestCommentAckAgeUnknown,
    rateLimited: freshRateLimitComments.length > 0,
  };
}

/**
 * Evidence that a Codex run for an OLDER commit was in flight across the push
 * and published after it.
 *
 * The hazard: a run started on the previous head, a push lands, the run finishes
 * and posts a verdict whose `created_at` post-dates the new head's anchor. Every
 * timestamp-bound ack leg accepts it. The sha-bound legs cannot be forged this
 * way, so this exists only to qualify the two that can — the `+1` and the
 * sha-less clean verdict — and `computeVerdict` refuses to read cleanliness off
 * them while it holds.
 *
 * Two independent traces, either sufficient:
 *   - a bot review whose `commit_id` is not HEAD, SUBMITTED at or after the
 *     anchor. The ordinary findings-then-fix flow never trips this: there the
 *     review predates the push it caused, so its `submitted_at` is earlier than
 *     the anchor by construction. Only a review landing AFTER the push has the
 *     cross-push signature.
 *   - a bot comment carrying a `Reviewed commit:` line that does not name HEAD,
 *     CREATED at or after the anchor. This is the trace that matters, because a
 *     clean pass usually posts NO review object at all, so on the dangerous
 *     path, the clean tail, the review trace is absent and this one is present.
 *
 * Residual: a run for the previous head that finishes with only a bare `+1`, or
 * only a sha-less clean comment, posts neither a review nor a citation, leaves
 * no trace for either test and is accepted. A clean comment in the current
 * format carries a `Reviewed commit:` line, which the second test catches, so
 * the gap is open on the reaction leg and on the comment leg only if Codex goes
 * back to a sha-less format. Requiring a sha on the ack would close it and is
 * refused for the reason `deriveCommentSignals` gives: it would bind this gate
 * to an external party's current wording.
 *
 * The empty-field guards run OPPOSITE to the ack legs', and deliberately: there,
 * matching is the ack, so an absent head must match NOTHING; here, matching is
 * suspicion, so an absent head must match EVERYTHING. `review.commit_id !==
 * headSha` already fails closed with no guard when `headSha` is absent; the
 * citation test needs the explicit `Boolean(headShaShort)` because
 * `"anything".includes("")` is true and would silently clear every citation.
 *
 * @param {{botReviews: Array<object>, botComments: Array<object>, headSha: string,
 *     headShaShort: string, ackAnchorMs: number}} input
 *   `botReviews` / `botComments` are the bot-filtered sets returned by
 *   `deriveReviewAck` / `deriveCommentSignals`, so the login form has exactly
 *   one authority.
 */
export function deriveStaleRunEvidence({
  botReviews,
  botComments,
  headSha,
  headShaShort,
  ackAnchorMs,
}) {
  const staleReviews = (botReviews ?? []).filter(
    (review) => review.commit_id !== headSha && isAtOrAfter(review.submitted_at, ackAnchorMs),
  );
  const staleCitations = (botComments ?? []).filter(
    (comment) =>
      REVIEWED_COMMIT_PATTERN.test(comment.body ?? "") &&
      !bodyNamesHead(comment.body, headShaShort) &&
      isAtOrAfter(comment.created_at, ackAnchorMs),
  );
  // Diagnostic only — the caller names the commit the operator should be looking
  // at. A body the capture does not fit contributes nothing rather than a wrong
  // sha, and no decision reads this.
  const staleCitedShas = [
    ...new Set(
      staleCitations
        .map((comment) => REVIEWED_COMMIT_SHA_PATTERN.exec(comment.body ?? "")?.[1])
        .filter((sha) => sha !== undefined),
    ),
  ];
  return {
    staleReviews,
    staleCitations,
    staleCitedShas,
    staleRunLandedAfterPush: staleReviews.length > 0 || staleCitations.length > 0,
  };
}

/**
 * Ack candidates the observation baseline REFUSED: timestamp-only acks that
 * clear the fallback anchor but predate the gate's first sighting of this sha as
 * HEAD.
 *
 * This function exists because the refusal is otherwise INVISIBLE. Raising the
 * anchor to the baseline makes `isAtOrAfter` drop these rows inside
 * `deriveReactionAck` / `deriveCommentSignals`, so no ack leg fires and the
 * ladder falls to `no_ack_yet`, which tells the operator Codex has not looked
 * yet when Codex has looked and posted and the gate cannot bind it.
 * Reconstructing the refused set lets the gate say why it refused.
 *
 * A SEPARATE pure function over the raw payloads rather than extra return
 * fields on the two derivers. Those answer "is there an ack"; this answers "was
 * there something that would have been an ack under the weaker floor", a
 * different question against the same rows, and threading a second anchor
 * through their signatures would put both questions in one function.
 *
 * SCOPE. Only the two timestamp-only legs can be refused this way, so only they
 * are reconstructed. A comment naming the head sha is bound by the sha and never
 * consults the baseline at all — excluded here by a plain substring test rather
 * than the narrower `Reviewed commit:` form, because over-excluding costs at
 * most an unreported diagnostic while under-excluding would report a sha-bound
 * ack as refused and send the operator after a stall that is not happening.
 *
 * An absent or non-finite `baselineMs` yields an empty set, which is correct
 * rather than a fallback: with no baseline there is no refusal-by-baseline to
 * report, and the unusable-store case is a different verdict input carrying a
 * different remediation.
 *
 * @param {{reactions: Array<object>, comments: Array<object>, headShaShort: string,
 *   fallbackAnchorMs: number, baselineMs: number | null}} input
 * @returns {{preBaselineReactions: Array<object>, preBaselineCleanComments: Array<object>,
 *   ackPredatesBaseline: boolean}}
 */
export function derivePreBaselineAcks({
  reactions,
  comments,
  headShaShort,
  fallbackAnchorMs,
  baselineMs,
}) {
  const empty = {
    preBaselineReactions: [],
    preBaselineCleanComments: [],
    ackPredatesBaseline: false,
  };
  if (!Number.isFinite(baselineMs)) return empty;

  // Would have acked under the weaker floor, does not clear the baseline.
  const refusedByBaseline = (timestamp) =>
    isAtOrAfter(timestamp, fallbackAnchorMs) && !isAtOrAfter(timestamp, baselineMs);

  const preBaselineReactions = (reactions ?? []).filter(
    (reaction) =>
      reaction.user?.login === BOT_REST_LOGIN &&
      reaction.content === "+1" &&
      refusedByBaseline(reaction.created_at),
  );
  const preBaselineCleanComments = (comments ?? []).filter(
    (comment) =>
      comment.user?.login === BOT_REST_LOGIN &&
      CLEAN_VERDICT_PATTERN.test(comment.body ?? "") &&
      !REVIEWED_COMMIT_PATTERN.test(comment.body ?? "") &&
      !bodyNamesHead(comment.body, headShaShort) &&
      refusedByBaseline(comment.created_at),
  );
  return {
    preBaselineReactions,
    preBaselineCleanComments,
    ackPredatesBaseline: preBaselineReactions.length > 0 || preBaselineCleanComments.length > 0,
  };
}

/**
 * Bot review threads that are still unresolved.
 *
 * Unresolved is the ENTIRE predicate; `isOutdated` is diagnostic metadata only.
 * GitHub's require-conversation-resolution keys on RESOLUTION, so a fix push
 * that marks a thread outdated without resolving it still blocks the merge.
 * Filtering outdated threads out would drop exactly those and report merge_ok=1
 * while GitHub reports BLOCKED.
 *
 * @param {Array<object>} threadNodes
 * @returns {{unresolved: Array<object>, outdatedCount: number}}
 */
export function selectUnresolvedBotThreads(threadNodes) {
  const unresolved = (threadNodes ?? []).filter(
    (thread) =>
      !thread.isResolved && thread.comments?.nodes?.[0]?.author?.login === BOT_GRAPHQL_LOGIN,
  );
  return {
    unresolved,
    outdatedCount: unresolved.filter((thread) => thread.isOutdated).length,
  };
}

/**
 * The age of an ack leg that DID fire: the measurement when there is one, and 0
 * when there is not.
 *
 * For a leg that did NOT fire, Infinity is correct: a rejected leg must not
 * shorten a settle window it has no standing in, which is why the caller
 * supplies that Infinity itself rather than routing through this function. For
 * a leg that DID fire, an age of NaN or undefined is not evidence that the ack
 * is old but the ABSENCE of evidence about when it landed. Both fail every `<`
 * test identically, so mapping the second case to Infinity would tell
 * `computeVerdict` the ack was outside the settle window and let it score
 * `ack_clean` + `merge_ok=1` before a delayed review thread could materialize.
 *
 * 0 is the fail-closed reading: an ack you cannot date is treated as one that
 * landed this instant, so the window holds it. That is deliberately sticky — an
 * ack that can never be dated never settles — so `computeVerdict` reports
 * `ackAgeUnknown` and the caller prints a remediation that does not amount to
 * "keep re-polling forever". `??` does not catch NaN; the test has to be
 * `Number.isFinite`.
 *
 * `Number.isFinite` also rejects `Infinity`, and on a FIRING leg that is the
 * point: a caller that passes Infinity as a missing-value sentinel must not have
 * it read as "infinitely old, therefore settled". No ack is infinitely old; the
 * derivers reserve Infinity for a leg that did not fire, and that case never
 * reaches this function.
 *
 * @param {number | undefined} ageMs
 * @returns {number}
 */
export function firingLegAgeMs(ageMs) {
  return Number.isFinite(ageMs) ? ageMs : 0;
}
