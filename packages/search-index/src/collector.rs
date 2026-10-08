//! Sessions ranked by their best matching row, and each session's hits, scored with FTS5's BM25 on
//! a version's live counts.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};

use tantivy::query::{Bm25StatisticsProvider, EnableScoring, Query, TermQuery};
use tantivy::schema::{Field, IndexRecordOption};
use tantivy::{DocId, DocSet, Score, Searcher, SegmentReader, TERMINATED, Term};

use crate::cursor::{CursorPurpose, PhraseCursor, open_phrase_cursor};
use crate::membership::GroupMembership;
use crate::phrase::Phrase;
use crate::schema::{IndexFields, Owner, owner_of, owner_value};
use crate::scorer::{phrase_ceiling, phrase_idf, row_score};
use crate::version::{IndexVersion, SegmentColumns};

/// Below this many rows matching the query's rarest phrase, every matching row is scored in one
/// pass instead of skipping blocks.
pub const FULL_PASS_BELOW: u64 = 50_000;

/// How far below the k-th session's best a skipped block's bound must stay: covers Tantivy's f32
/// scores against the exact f64 ones.
const CUTOFF_MARGIN: f64 = 1e-4;

/// A query prepared against one version: its phrases with their live row counts and IDFs, and the
/// term that drives block skipping.
pub struct PreparedQuery {
    phrases: Vec<Phrase>,
    phrase_rows: Vec<u64>,
    idfs: Vec<f64>,
    average_length: f64,
    driver: Option<Driver>,
}

// The phrase whose single term Tantivy walks with block-max skipping, and that term: the phrase's
// own term; or one that holds each of the phrase's rows at least as many times, the longest prefix
// field's term for a prefix longer than every prefix field and the rarest whole token for a phrase
// of several tokens.
struct Driver {
    phrase: usize,
    term: Term,
}

impl PreparedQuery {
    /// The query against `version`; `None` when no row can match it: no phrase, or a phrase no live
    /// row holds.
    pub fn prepare(
        version: &IndexVersion,
        phrases: Vec<Phrase>,
    ) -> tantivy::Result<Option<PreparedQuery>> {
        if phrases.is_empty() || version.live_rows == 0 {
            return Ok(None);
        }
        let phrase_rows = phrases
            .iter()
            .map(|phrase| version.phrase_rows(phrase))
            .collect::<tantivy::Result<Vec<_>>>()?;
        if phrase_rows.contains(&0) {
            return Ok(None);
        }
        let idfs = phrase_rows
            .iter()
            .map(|rows| phrase_idf(version.live_rows, *rows))
            .collect();
        let driver = choose_driver(version, &phrases, &phrase_rows)?;
        Ok(Some(PreparedQuery {
            phrases,
            phrase_rows,
            idfs,
            average_length: version.average_length(),
            driver,
        }))
    }

    /// The live row count of the query's rarest phrase: no more rows than this can match.
    pub fn fewest_rows(&self) -> u64 {
        self.phrase_rows.iter().copied().min().unwrap_or(0)
    }

    fn score(&self, frequencies: &[u32], length: u64) -> f64 {
        row_score(&self.idfs, frequencies, length, self.average_length)
    }
}

fn choose_driver(
    version: &IndexVersion,
    phrases: &[Phrase],
    phrase_rows: &[u64],
) -> tantivy::Result<Option<Driver>> {
    let mut chosen: Option<Driver> = None;
    for (index, phrase) in phrases.iter().enumerate() {
        let term = match phrase
            .single_term(&version.fields)
            .or_else(|| phrase.long_prefix_field_term(&version.fields))
        {
            Some(term) => Some(term),
            None => rarest_term(&version.searcher, phrase.whole_part_terms(&version.fields))?,
        };
        let Some(term) = term else { continue };
        if chosen
            .as_ref()
            .is_none_or(|driver| phrase_rows[index] < phrase_rows[driver.phrase])
        {
            chosen = Some(Driver {
                phrase: index,
                term,
            });
        }
    }
    Ok(chosen)
}

fn rarest_term(searcher: &Searcher, terms: Vec<Term>) -> tantivy::Result<Option<Term>> {
    let mut rarest: Option<(u64, Term)> = None;
    for term in terms {
        let rows = searcher.doc_freq(&term)?;
        if rarest.as_ref().is_none_or(|(fewest, _)| rows < *fewest) {
            rarest = Some((rows, term));
        }
    }
    Ok(rarest.map(|(_, term)| term))
}

/// What ranks a row for a session: higher score first, then lower row key, then the session's
/// place among a group's members.
#[derive(Clone, Copy, Debug)]
struct RankKey {
    score: f64,
    row_key: u64,
    member_place: u32,
}

impl Ord for RankKey {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .total_cmp(&self.score)
            .then(self.row_key.cmp(&other.row_key))
            .then(self.member_place.cmp(&other.member_place))
    }
}

impl PartialOrd for RankKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for RankKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for RankKey {}

/// The sessions a search is limited to, and the owners whose rows count toward them.
pub struct SessionSet {
    sessions: HashSet<u64>,
    owners: HashSet<u64>,
}

impl SessionSet {
    /// `sessions` with the groups they belong to under `membership`.
    pub fn new(sessions: &[u64], membership: &GroupMembership) -> SessionSet {
        let mut owners = HashSet::new();
        for session in sessions {
            owners.insert(owner_value(Owner::Session(*session)));
            for group in membership.groups_of(*session) {
                owners.insert(owner_value(Owner::Group(*group)));
            }
        }
        SessionSet {
            sessions: sessions.iter().copied().collect(),
            owners,
        }
    }

    /// About how many rows of `segment` the set's owners hold: their share of its owners' rows.
    fn estimated_rows_in(
        &self,
        segment: &SegmentReader,
        fields: &IndexFields,
    ) -> tantivy::Result<u64> {
        let owner_terms = segment
            .inverted_index(fields.owner)?
            .terms()
            .num_terms()
            .max(1);
        Ok(self.owners.len() as u64 * u64::from(segment.max_doc()) / owner_terms as u64)
    }

    /// About how many rows of `version` the set's owners hold.
    pub fn estimated_rows(&self, version: &IndexVersion) -> tantivy::Result<u64> {
        let mut rows = 0;
        for segment in version.searcher.segment_readers() {
            rows += self.estimated_rows_in(segment, &version.fields)?;
        }
        Ok(rows)
    }

    /// Whether the set holds no session.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    fn holds_owner(&self, owner: u64) -> bool {
        self.owners.contains(&owner)
    }

    fn holds_session(&self, session: u64) -> bool {
        self.sessions.contains(&session)
    }
}

// The sessions a row counts toward, each with its place: the owning session, or each member of
// the owning group.
fn credit_sessions(membership: &GroupMembership, owner: u64, mut credit: impl FnMut(u64, u32)) {
    match owner_of(owner) {
        Owner::Session(session) => credit(session, 0),
        Owner::Group(group) => {
            for (place, session) in membership.members_of(group).iter().enumerate() {
                credit(*session, place as u32);
            }
        }
    }
}

fn open_cursors(
    segment: &SegmentReader,
    fields: &IndexFields,
    phrases: &[Phrase],
) -> tantivy::Result<Option<Vec<PhraseCursor>>> {
    let mut cursors = Vec::with_capacity(phrases.len());
    for phrase in phrases {
        match open_phrase_cursor(segment, fields, phrase, CursorPurpose::Score)? {
            Some(cursor) => cursors.push(cursor),
            None => return Ok(None),
        }
    }
    Ok(Some(cursors))
}

// Whether every cursor sits on `doc`, each moved there or past it.
fn all_on(cursors: &mut [PhraseCursor], doc: DocId) -> bool {
    cursors.iter_mut().all(|cursor| cursor.seek(doc) == doc)
}

fn frequencies_into(cursors: &mut [PhraseCursor], frequencies: &mut [u32]) {
    for (frequency, cursor) in frequencies.iter_mut().zip(cursors) {
        *frequency = cursor.frequency();
    }
}

/// The rows of `owners` in `segment`, ascending.
fn owner_docs(
    segment: &SegmentReader,
    fields: &IndexFields,
    owners: &HashSet<u64>,
) -> tantivy::Result<Vec<DocId>> {
    let inverted = segment.inverted_index(fields.owner)?;
    let mut docs = Vec::new();
    for owner in owners {
        let term = Term::from_field_u64(fields.owner, *owner);
        if let Some(mut postings) = inverted.read_postings(&term, IndexRecordOption::Basic)? {
            let mut doc = postings.doc();
            while doc != TERMINATED {
                docs.push(doc);
                doc = postings.advance();
            }
        }
    }
    docs.sort_unstable();
    Ok(docs)
}

// Visits every live row of segment `ordinal` that matches every phrase, with its exact score. With
// `within`, a row's owner is checked before the row is scored, and the walk starts from the set's
// own rows when they are fewer than the rarest phrase's.
fn visit_matches_in(
    version: &IndexVersion,
    ordinal: usize,
    query: &PreparedQuery,
    within: Option<&SessionSet>,
    visit: &mut dyn FnMut(&SegmentColumns, DocId, f64),
) -> tantivy::Result<()> {
    let segment = &version.searcher.segment_readers()[ordinal];
    let columns = &version.segments[ordinal].columns;
    let Some(mut cursors) = open_cursors(segment, &version.fields, &query.phrases)? else {
        return Ok(());
    };
    let alive = segment.alive_bitset();
    let is_alive = |doc: DocId| alive.is_none_or(|alive| alive.is_alive(doc));
    let mut frequencies = vec![0u32; cursors.len()];
    let lead = (0..cursors.len())
        .min_by_key(|index| cursors[*index].cost())
        .unwrap_or(0);
    if let Some(set) = within
        && set.estimated_rows_in(segment, &version.fields)? < cursors[lead].cost()
    {
        for doc in owner_docs(segment, &version.fields, &set.owners)? {
            if is_alive(doc) && all_on(&mut cursors, doc) {
                frequencies_into(&mut cursors, &mut frequencies);
                visit(
                    columns,
                    doc,
                    query.score(&frequencies, columns.length.get_val(doc)),
                );
            }
        }
        return Ok(());
    }
    let mut doc = cursors[lead].doc();
    'rows: while doc != TERMINATED {
        let owner_allowed = within.is_none_or(|set| set.holds_owner(columns.owner.get_val(doc)));
        if !is_alive(doc) || !owner_allowed {
            doc = cursors[lead].advance();
            continue;
        }
        for index in 0..cursors.len() {
            let at = cursors[index].seek(doc);
            if at != doc {
                doc = cursors[lead].seek(at);
                continue 'rows;
            }
        }
        frequencies_into(&mut cursors, &mut frequencies);
        visit(
            columns,
            doc,
            query.score(&frequencies, columns.length.get_val(doc)),
        );
        doc = cursors[lead].advance();
    }
    Ok(())
}

/// Every matching session in rank order, with each one's hits best first, from one pass over
/// every matching row.
pub struct ScoredSessions {
    pub order: Vec<u64>,
    pub hits: HashMap<u64, Vec<u64>>,
}

/// Scores every row matching `query`, limited to `within` when given, and ranks the sessions.
pub fn score_every_session(
    version: &IndexVersion,
    query: &PreparedQuery,
    within: Option<&SessionSet>,
) -> tantivy::Result<ScoredSessions> {
    let mut best: HashMap<u64, RankKey> = HashMap::new();
    let mut rows: HashMap<u64, Vec<RankKey>> = HashMap::new();
    for ordinal in 0..version.segments.len() {
        let mut credit_row = |columns: &SegmentColumns, doc: DocId, score: f64| {
            let row_key = columns.key.get_val(doc);
            credit_sessions(
                &version.membership,
                columns.owner.get_val(doc),
                |session, place| {
                    if within.is_some_and(|set| !set.holds_session(session)) {
                        return;
                    }
                    let key = RankKey {
                        score,
                        row_key,
                        member_place: place,
                    };
                    best.entry(session)
                        .and_modify(|held| *held = (*held).min(key))
                        .or_insert(key);
                    rows.entry(session).or_default().push(RankKey {
                        member_place: 0,
                        ..key
                    });
                },
            );
        };
        visit_matches_in(version, ordinal, query, within, &mut credit_row)?;
    }
    let mut order: Vec<(RankKey, u64)> = best
        .into_iter()
        .map(|(session, key)| (key, session))
        .collect();
    order.sort_unstable();
    let hits = rows
        .into_iter()
        .map(|(session, mut keys)| {
            keys.sort_unstable();
            (session, keys.into_iter().map(|key| key.row_key).collect())
        })
        .collect();
    Ok(ScoredSessions {
        order: order.into_iter().map(|(_, session)| session).collect(),
        hits,
    })
}

// The best k sessions with each one's best row, in rank order.
struct TopSessions {
    k: usize,
    best: HashMap<u64, RankKey>,
    ranked: BTreeSet<(RankKey, u64)>,
}

impl TopSessions {
    fn new(k: usize) -> TopSessions {
        TopSessions {
            k,
            best: HashMap::new(),
            ranked: BTreeSet::new(),
        }
    }

    fn offer(&mut self, session: u64, key: RankKey) {
        if let Some(held) = self.best.get(&session).copied() {
            if key < held {
                self.ranked.remove(&(held, session));
                self.ranked.insert((key, session));
                self.best.insert(session, key);
            }
            return;
        }
        if self.ranked.len() == self.k {
            let Some(&(worst, worst_session)) = self.ranked.last() else {
                return;
            };
            if key >= worst {
                return;
            }
            self.ranked.remove(&(worst, worst_session));
            self.best.remove(&worst_session);
        }
        self.ranked.insert((key, session));
        self.best.insert(session, key);
    }

    // The k-th session's best score once k sessions are held: a row below it changes nothing.
    fn cutoff(&self) -> Option<f64> {
        if self.ranked.len() < self.k {
            return None;
        }
        self.ranked.last().map(|(key, _)| key.score)
    }

    fn into_sessions(self) -> Vec<u64> {
        self.ranked
            .into_iter()
            .map(|(_, session)| session)
            .collect()
    }
}

// Tantivy's BM25 statistics replaced by the version's live counts, so its average length is the
// live one.
struct LiveStatistics {
    live_rows: u64,
    live_tokens: u64,
    driver_rows: u64,
}

impl Bm25StatisticsProvider for LiveStatistics {
    fn total_num_tokens(&self, _: Field) -> tantivy::Result<u64> {
        Ok(self.live_tokens)
    }

    fn total_num_docs(&self) -> tantivy::Result<u64> {
        Ok(self.live_rows)
    }

    fn doc_freq(&self, _: &Term) -> tantivy::Result<u64> {
        Ok(self.driver_rows)
    }
}

// Tantivy's IDF, computed in f32 as Tantivy computes it.
fn tantivy_idf(phrase_rows: u64, live_rows: u64) -> f64 {
    let ratio = ((live_rows - phrase_rows) as Score + 0.5) / (phrase_rows as Score + 0.5);
    f64::from((1.0 as Score + ratio).ln())
}

/// The best `k` sessions in rank order, limited to `within` when given, Tantivy skipping the driver
/// term's blocks that cannot reach the k-th session's best row; `None` when no phrase has a single
/// term to drive the skip.
pub fn top_sessions(
    version: &IndexVersion,
    query: &PreparedQuery,
    k: usize,
    within: Option<&SessionSet>,
) -> tantivy::Result<Option<Vec<u64>>> {
    let Some(driver) = &query.driver else {
        return Ok(None);
    };
    let statistics = LiveStatistics {
        live_rows: version.live_rows,
        live_tokens: version.live_tokens,
        driver_rows: query.phrase_rows[driver.phrase],
    };
    let scoring = EnableScoring::enabled_from_statistics_provider(&statistics, &version.searcher);
    let weight =
        TermQuery::new(driver.term.clone(), IndexRecordOption::WithFreqs).weight(scoring)?;
    let driver_idf = tantivy_idf(statistics.driver_rows, statistics.live_rows);
    let ratio = query.idfs[driver.phrase] / driver_idf;
    let query_average = f64::from(statistics.live_tokens as Score / statistics.live_rows as Score);
    let others_ceiling: f64 = (0..query.phrases.len())
        .filter(|index| *index != driver.phrase)
        .map(|index| phrase_ceiling(query.idfs[index]))
        .sum();
    let mut top = TopSessions::new(k);
    for (ordinal, segment) in version.searcher.segment_readers().iter().enumerate() {
        let Some(mut cursors) = open_cursors(segment, &version.fields, &query.phrases)? else {
            continue;
        };
        let columns = &version.segments[ordinal].columns;
        let alive = segment.alive_bitset();
        let drift = average_drift(segment, driver.term.field(), query_average)?;
        // A row's exact score is at most its driver part plus every other phrase's ceiling, and its
        // driver part at most `ratio` times Tantivy's score of the driver term: the phrase's count
        // never exceeds the term's and Tantivy's stored length rounds down. A block's stored bound
        // was chosen under its segment's average length when written, and under today's average any
        // row's score moves by at most the two averages' ratio, so the cutoff is divided by that
        // drift too. Every row Tantivy calls back is scored exactly.
        let driver_threshold = |cutoff: Option<f64>| -> Score {
            let Some(cutoff) = cutoff else { return 0.0 };
            ((cutoff - others_ceiling) / (ratio * drift) * (1.0 - CUTOFF_MARGIN)).max(0.0) as Score
        };
        let mut frequencies = vec![0u32; cursors.len()];
        let first_threshold = driver_threshold(top.cutoff());
        let mut callback = |doc: DocId, _: Score| -> Score {
            let owner = columns.owner.get_val(doc);
            if within.is_none_or(|set| set.holds_owner(owner))
                && alive.is_none_or(|alive| alive.is_alive(doc))
                && all_on(&mut cursors, doc)
            {
                frequencies_into(&mut cursors, &mut frequencies);
                let score = query.score(&frequencies, columns.length.get_val(doc));
                let row_key = columns.key.get_val(doc);
                credit_sessions(&version.membership, owner, |session, place| {
                    if within.is_none_or(|set| set.holds_session(session)) {
                        top.offer(
                            session,
                            RankKey {
                                score,
                                row_key,
                                member_place: place,
                            },
                        );
                    }
                });
            }
            driver_threshold(top.cutoff())
        };
        weight.for_each_pruning(first_threshold, segment, &mut callback)?;
    }
    Ok(Some(top.into_sessions()))
}

// How far the live average length has moved from the average `segment` chose its block bounds
// under, as the larger over the smaller.
fn average_drift(
    segment: &SegmentReader,
    field: Field,
    query_average: f64,
) -> tantivy::Result<f64> {
    let written_tokens = segment.inverted_index(field)?.total_num_tokens();
    let write_average = f64::from(written_tokens as Score / segment.max_doc() as Score);
    Ok(write_average.max(query_average) / write_average.min(query_average))
}

/// Each named session's hits, best first, in the order the sessions are named: the session's own
/// rows and its groups' rows, read through the owner key with the phrases sought at each.
pub fn hits_of(
    version: &IndexVersion,
    query: &PreparedQuery,
    sessions: &[u64],
) -> tantivy::Result<Vec<Vec<u64>>> {
    let wanted = SessionSet::new(sessions, &version.membership);
    let mut rows: HashMap<u64, Vec<RankKey>> = HashMap::new();
    for (ordinal, segment) in version.searcher.segment_readers().iter().enumerate() {
        let docs = owner_docs(segment, &version.fields, &wanted.owners)?;
        if docs.is_empty() {
            continue;
        }
        let Some(mut cursors) = open_cursors(segment, &version.fields, &query.phrases)? else {
            continue;
        };
        let columns = &version.segments[ordinal].columns;
        let alive = segment.alive_bitset();
        let mut frequencies = vec![0u32; cursors.len()];
        for doc in docs {
            if !alive.is_none_or(|alive| alive.is_alive(doc)) || !all_on(&mut cursors, doc) {
                continue;
            }
            frequencies_into(&mut cursors, &mut frequencies);
            let score = query.score(&frequencies, columns.length.get_val(doc));
            let row_key = columns.key.get_val(doc);
            credit_sessions(
                &version.membership,
                columns.owner.get_val(doc),
                |session, _| {
                    if wanted.sessions.contains(&session) {
                        let key = RankKey {
                            score,
                            row_key,
                            member_place: 0,
                        };
                        rows.entry(session).or_default().push(key);
                    }
                },
            );
        }
    }
    for keys in rows.values_mut() {
        keys.sort_unstable();
    }
    Ok(sessions
        .iter()
        .map(|session| {
            let keys = rows.get(session).map_or(&[][..], Vec::as_slice);
            keys.iter().map(|key| key.row_key).collect()
        })
        .collect())
}
