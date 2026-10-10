//! Cursors over the rows a phrase matches in one segment, with how often it matches each row.

pub mod token;

use tantivy::schema::IndexRecordOption;
use tantivy::{DocId, SegmentReader, TERMINATED};

use crate::phrase::{PairRows, Phrase};
use crate::schema::{IndexFields, PREFIX_FIELD_COUNT};
use token::{
    PrefixWords, TokenCursor, prefix_cursor, prefix_term_infos, term_cursor, text_cursor,
    word_union,
};

/// What a cursor is opened for: scoring needs each phrase's count per row; marking needs where in
/// the row each phrase sits, so every phrase reads positions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorPurpose {
    Score,
    Mark,
}

/// How many rows a cursor will be asked for: every row it holds, walked, or at most this many,
/// each sought.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowsAsked {
    Every,
    AtMost(u64),
}

/// Opens `phrase`'s cursor in `segment`, or `None` when no row of the segment can match it.
pub fn open_phrase_cursor(
    segment: &SegmentReader,
    fields: &IndexFields,
    phrase: &Phrase,
    purpose: CursorPurpose,
    asked: RowsAsked,
) -> tantivy::Result<Option<PhraseCursor>> {
    if purpose == CursorPurpose::Score {
        if let Some(term) = phrase.single_term(fields) {
            let token = term_cursor(segment, &term, IndexRecordOption::WithFreqs)?;
            return Ok(token.map(PhraseCursor::Token));
        }
        if let Some(PairRows::Prefix(text)) = phrase.exact_pair_rows(fields) {
            let term_infos = prefix_term_infos(segment, fields.pair, &text)?;
            let token = prefix_cursor(segment, fields.pair, &term_infos, asked)?;
            return Ok(token.map(PhraseCursor::Token));
        }
        // A long prefix whose first four characters begin no other word of the segment counts as
        // often in a row as the four-character field's term; any other sums its words.
        if let (Some(term), [part]) = (phrase.long_prefix_field_term(fields), &phrase.parts[..]) {
            let token = match PrefixWords::read(segment, fields, part)? {
                PrefixWords::Pinned => term_cursor(segment, &term, IndexRecordOption::WithFreqs)?,
                PrefixWords::Listed(term_infos) => {
                    prefix_cursor(segment, fields.text, &term_infos, asked)?
                }
            };
            return Ok(token.map(PhraseCursor::Token));
        }
    }
    // Every one-token phrase a score reads has returned above, so this one is marked.
    if let [part] = phrase.parts.as_slice() {
        let token = text_cursor(segment, fields, part, phrase.ends_in_prefix)?;
        return Ok(token.map(PhraseCursor::Token));
    }
    // The pairs first: a segment lacking one holds no row of the phrase, and its tokens' cursors
    // are left unopened. A pair's places stand for a token's where they pin it, read in place of
    // the token's own far longer lists, one cursor for both tokens when the pair pins both: a token
    // shorter than the pair field's cut is the pair's first; the last token is the pair's second,
    // one place on, when it is a whole word shorter than the cut, a prefix no longer than the cut,
    // or a prefix whose cut begins no word of the segment it does not. Every other pair filters.
    let positions = IndexRecordOption::WithFreqsAndPositions;
    let last = phrase.parts.len() - 1;
    let mut cursors = Vec::with_capacity(phrase.parts.len() * 2 - 1);
    let mut sources: Vec<Option<(usize, u32)>> = vec![None; phrase.parts.len()];
    let mut filters = Vec::with_capacity(last);
    // The last token's words, read while asking whether its pair pins it.
    let mut last_words = None;
    for (first, rows) in phrase.pair_rows(fields).into_iter().enumerate() {
        let second = first + 1;
        let pins_first = phrase.parts[first].chars().count() < PREFIX_FIELD_COUNT;
        let pins_second = second == last
            && match &rows {
                PairRows::Prefix(_) => true,
                PairRows::Term(_) if phrase.is_prefix_part(second) => {
                    match PrefixWords::read(segment, fields, &phrase.parts[second])? {
                        PrefixWords::Pinned => true,
                        PrefixWords::Listed(term_infos) => {
                            last_words = Some(term_infos);
                            false
                        }
                    }
                }
                PairRows::Term(_) => phrase.parts[second].chars().count() < PREFIX_FIELD_COUNT,
            };
        let is_read = pins_first || pins_second;
        let record = if is_read {
            positions
        } else {
            IndexRecordOption::Basic
        };
        let opened = match &rows {
            PairRows::Term(term) => term_cursor(segment, term, record)?,
            PairRows::Prefix(text) => {
                let term_infos = prefix_term_infos(segment, fields.pair, text)?;
                word_union(segment, fields.pair, &term_infos, record)?
            }
        };
        let Some(cursor) = opened else {
            return Ok(None);
        };
        if !is_read {
            filters.push(cursor);
            continue;
        }
        for (index, shift, pins) in [(first, 0, pins_first), (second, 1, pins_second)] {
            if pins {
                sources[index] = Some((cursors.len(), shift));
            }
        }
        cursors.push(cursor);
    }
    let mut parts = Vec::with_capacity(phrase.parts.len());
    for (index, part) in phrase.parts.iter().enumerate() {
        if let Some(source) = sources[index] {
            parts.push(source);
            continue;
        }
        let cursor = if index == last
            && let Some(term_infos) = last_words.take()
        {
            word_union(segment, fields.text, &term_infos, positions)?
        } else {
            text_cursor(segment, fields, part, phrase.is_prefix_part(index))?
        };
        let Some(cursor) = cursor else {
            return Ok(None);
        };
        parts.push((cursors.len(), 0));
        cursors.push(cursor);
    }
    let positioned = cursors.len();
    cursors.extend(filters);
    Ok(Some(PhraseCursor::Sequence(SequenceCursor::new(
        cursors, positioned, parts,
    ))))
}

/// Every phrase's cursor in `segment`, in phrase order, or `None` when no row of the segment can
/// match one of them.
pub fn open_cursors(
    segment: &SegmentReader,
    fields: &IndexFields,
    phrases: &[Phrase],
    purpose: CursorPurpose,
    asked: RowsAsked,
) -> tantivy::Result<Option<Vec<PhraseCursor>>> {
    let mut cursors = Vec::with_capacity(phrases.len());
    for phrase in phrases {
        match open_phrase_cursor(segment, fields, phrase, purpose, asked)? {
            Some(cursor) => cursors.push(cursor),
            None => return Ok(None),
        }
    }
    Ok(Some(cursors))
}

/// Whether every phrase matches row `doc`, each cursor moved there or past it.
pub fn all_on(cursors: &mut [PhraseCursor], doc: DocId) -> bool {
    cursors.iter_mut().all(|cursor| cursor.matches_at(doc))
}

/// A segment's phrase cursors for rows asked in increasing order, opened only at the first row
/// that can match: a long prefix's cursor reads every word it begins, so a row the four-character
/// prefix field's term lacks is turned away first, and a segment where no row asked can match
/// reads none of the words.
pub struct GatedCursors<'a> {
    segment: &'a SegmentReader,
    fields: &'a IndexFields,
    phrases: &'a [Phrase],
    purpose: CursorPurpose,
    asked: RowsAsked,
    // The four-character field's postings of each phrase that is a longer prefix: they hold every
    // row the prefix's words hold.
    filters: Vec<TokenCursor>,
    cursors: GatedState,
}

enum GatedState {
    Closed,
    Open(Vec<PhraseCursor>),
    NoRowMatches,
}

/// How a row asked of `GatedCursors` stands.
pub enum RowMatch<'c> {
    /// Every phrase matches the row; the cursors sit on it.
    Matches(&'c mut [PhraseCursor]),
    /// The row misses a phrase.
    Misses,
    /// No row of the segment matches every phrase.
    NoRowMatches,
}

impl<'a> GatedCursors<'a> {
    /// The gate of `phrases` in `segment`, its cursors not yet opened, for at most `asked` rows.
    pub fn new(
        segment: &'a SegmentReader,
        fields: &'a IndexFields,
        phrases: &'a [Phrase],
        purpose: CursorPurpose,
        asked: u64,
    ) -> tantivy::Result<GatedCursors<'a>> {
        let mut filters = Vec::new();
        let mut cursors = GatedState::Closed;
        for phrase in phrases {
            let Some(term) = phrase.long_prefix_field_term(fields) else {
                continue;
            };
            match term_cursor(segment, &term, IndexRecordOption::Basic)? {
                Some(filter) => filters.push(filter),
                None => {
                    cursors = GatedState::NoRowMatches;
                    break;
                }
            }
        }
        Ok(GatedCursors {
            segment,
            fields,
            phrases,
            purpose,
            asked: RowsAsked::AtMost(asked),
            filters,
            cursors,
        })
    }

    /// Whether row `doc` matches every phrase, opening the cursors at the first row the filters
    /// admit.
    pub fn at(&mut self, doc: DocId) -> tantivy::Result<RowMatch<'_>> {
        if matches!(self.cursors, GatedState::NoRowMatches) {
            return Ok(RowMatch::NoRowMatches);
        }
        if !self
            .filters
            .iter_mut()
            .all(|filter| filter.seek(doc) == doc)
        {
            return Ok(RowMatch::Misses);
        }
        if matches!(self.cursors, GatedState::Closed) {
            self.cursors = match open_cursors(
                self.segment,
                self.fields,
                self.phrases,
                self.purpose,
                self.asked,
            )? {
                Some(cursors) => GatedState::Open(cursors),
                None => GatedState::NoRowMatches,
            };
        }
        Ok(match &mut self.cursors {
            GatedState::Open(cursors) => {
                if all_on(cursors, doc) {
                    RowMatch::Matches(cursors)
                } else {
                    RowMatch::Misses
                }
            }
            _ => RowMatch::NoRowMatches,
        })
    }
}

/// A phrase's rows: one token's, or a typed word of several tokens, whose rows hold its tokens next
/// to each other in order.
pub enum PhraseCursor {
    Token(TokenCursor),
    Sequence(SequenceCursor),
}

impl PhraseCursor {
    /// The row the cursor is on, `TERMINATED` past the last; a typed word finds its first row the
    /// first time a row is asked of it.
    pub fn doc(&mut self) -> DocId {
        match self {
            PhraseCursor::Token(token) => token.doc(),
            PhraseCursor::Sequence(sequence) => sequence.doc(),
        }
    }

    /// Moves to the next row the phrase matches.
    pub fn advance(&mut self) -> DocId {
        match self {
            PhraseCursor::Token(token) => token.advance(),
            PhraseCursor::Sequence(sequence) => sequence.advance(),
        }
    }

    /// Moves to the first row at or after `target` the phrase matches; a cursor already there
    /// stays.
    pub fn seek(&mut self, target: DocId) -> DocId {
        match self {
            PhraseCursor::Token(token) => token.seek(target),
            PhraseCursor::Sequence(sequence) => sequence.seek(target),
        }
    }

    /// Whether the phrase matches row `target`, at or after the cursor's row, a typed word's
    /// positions read only there. After a miss, only `matches_at` and `seek` go on from `target`.
    pub fn matches_at(&mut self, target: DocId) -> bool {
        match self {
            PhraseCursor::Token(token) => token.seek(target) == target,
            PhraseCursor::Sequence(sequence) => sequence.matches_at(target),
        }
    }

    /// How many times the phrase occurs in the current row.
    pub fn frequency(&mut self) -> u32 {
        match self {
            PhraseCursor::Token(token) => token.frequency(),
            PhraseCursor::Sequence(sequence) => sequence.starts.len() as u32,
        }
    }

    /// The positions of every token the phrase covers in the current row, ascending, into `marked`.
    /// The cursor must be opened for `CursorPurpose::Mark`.
    pub fn marked_positions(&mut self, marked: &mut Vec<u32>) {
        match self {
            PhraseCursor::Token(token) => token.positions(marked),
            PhraseCursor::Sequence(sequence) => {
                marked.clear();
                let width = sequence.parts.len() as u32;
                for start in &sequence.starts {
                    marked.extend(*start..*start + width);
                }
                marked.sort_unstable();
                marked.dedup();
            }
        }
    }

    /// The rows the cursor can visit at most, counted with deleted rows.
    pub fn cost(&self) -> u64 {
        match self {
            PhraseCursor::Token(token) => token.cost(),
            PhraseCursor::Sequence(sequence) => sequence.cursors[sequence.leader].cost(),
        }
    }
}

/// A typed word of several tokens: the rows where every token sits right after the one before,
/// walked from its rarest token or pair of neighbors. A row's positions are read only where every
/// token and pair term is, and only once a row is asked: a check of one row reads them there alone,
/// never at rows a cursor passes on the way.
pub struct SequenceCursor {
    /// The cursors that give places, then each pair term that filters.
    cursors: Vec<TokenCursor>,
    /// How many of `cursors` give places.
    positioned: usize,
    /// For each token in order, the cursor holding its places and how many places before the token
    /// that cursor holds them: one for a token read as its pair's second, zero for the rest.
    parts: Vec<(usize, u32)>,
    leader: usize,
    /// The row the cursor is on; `None` until a row is first asked of it.
    doc: Option<DocId>,
    starts: Vec<u32>,
    /// Each positioned cursor's places in the current row.
    places: Vec<Vec<u32>>,
}

impl SequenceCursor {
    fn new(
        cursors: Vec<TokenCursor>,
        positioned: usize,
        parts: Vec<(usize, u32)>,
    ) -> SequenceCursor {
        let leader = (0..cursors.len())
            .min_by_key(|index| cursors[*index].cost())
            .unwrap_or(0);
        SequenceCursor {
            cursors,
            positioned,
            parts,
            leader,
            doc: None,
            starts: Vec::new(),
            places: vec![Vec::new(); positioned],
        }
    }

    fn doc(&mut self) -> DocId {
        match self.doc {
            Some(doc) => doc,
            None => self.find_match(),
        }
    }

    fn advance(&mut self) -> DocId {
        self.doc();
        self.cursors[self.leader].advance();
        self.find_match()
    }

    // Whether `target` holds every part in order, without reading positions at any row past it.
    // A miss leaves `doc` short of `target`, or unknown, so a later seek checks the rows past it.
    fn matches_at(&mut self, target: DocId) -> bool {
        if let Some(doc) = self.doc
            && doc >= target
        {
            return doc == target;
        }
        let cursors = &mut self.cursors;
        let is_on = (self.positioned..cursors.len())
            .chain(0..self.positioned)
            .all(|index| cursors[index].seek(target) == target);
        if is_on && self.collect_starts() {
            self.doc = Some(target);
            return true;
        }
        false
    }

    fn seek(&mut self, target: DocId) -> DocId {
        if let Some(doc) = self.doc
            && doc >= target
        {
            return doc;
        }
        self.cursors[self.leader].seek(target);
        self.find_match()
    }

    // From the leader's row on, the first row holding every part in order.
    fn find_match(&mut self) -> DocId {
        let mut candidate = self.cursors[self.leader].doc();
        'candidates: while candidate != TERMINATED {
            // The pair terms, rarer than the tokens, first.
            for index in (self.positioned..self.cursors.len()).chain(0..self.positioned) {
                let doc = self.cursors[index].seek(candidate);
                if doc != candidate {
                    candidate = self.cursors[self.leader].seek(doc);
                    continue 'candidates;
                }
            }
            if self.collect_starts() {
                self.doc = Some(candidate);
                return candidate;
            }
            candidate = self.cursors[self.leader].advance();
        }
        self.starts.clear();
        self.doc = Some(TERMINATED);
        TERMINATED
    }

    // The places where the first part starts a full run of the parts in the current row, each
    // positioned cursor's places read once.
    fn collect_starts(&mut self) -> bool {
        for (cursor, places) in self.cursors.iter_mut().zip(self.places.iter_mut()) {
            cursor.positions(places);
        }
        self.starts.clear();
        let Some((&(first, first_shift), rest)) = self.parts.split_first() else {
            return false;
        };
        for place in &self.places[first] {
            let start = place + first_shift;
            // Part `offset + 1` sits at `start + offset + 1`, its cursor's place `shift` before it.
            let in_order = rest.iter().enumerate().all(|(offset, &(cursor, shift))| {
                self.places[cursor]
                    .binary_search(&(start + offset as u32 + 1 - shift))
                    .is_ok()
            });
            if in_order {
                self.starts.push(start);
            }
        }
        !self.starts.is_empty()
    }
}
