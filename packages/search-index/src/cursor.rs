//! Cursors over the rows a phrase matches in one segment, with how often it matches each row.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use tantivy::postings::{Postings, SegmentPostings, TermInfo};
use tantivy::query::BitSetDocSet;
use tantivy::schema::{Field, IndexRecordOption};
use tantivy::{DocId, DocSet, InvertedIndexReader, SegmentReader, TERMINATED, Term};
use tantivy_common::BitSet;

use crate::phrase::Phrase;
use crate::schema::IndexFields;

/// What a cursor is opened for: scoring needs each phrase's count per row; marking needs where in
/// the row each phrase sits, so every phrase reads the text field's positions.
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
    if let [part] = phrase.parts.as_slice() {
        let token = match (purpose, phrase.single_term(fields)) {
            (CursorPurpose::Score, Some(term)) => {
                term_cursor(segment, &term, IndexRecordOption::WithFreqs)?
            }
            (CursorPurpose::Score, None) => prefix_cursor(segment, fields.text, part, asked)?,
            (CursorPurpose::Mark, _) => text_cursor(segment, fields, part, phrase.ends_in_prefix)?,
        };
        return Ok(token.map(PhraseCursor::Token));
    }
    let mut parts = Vec::with_capacity(phrase.parts.len());
    for (index, part) in phrase.parts.iter().enumerate() {
        match text_cursor(segment, fields, part, phrase.is_prefix_part(index))? {
            Some(cursor) => parts.push(cursor),
            None => return Ok(None),
        }
    }
    Ok(Some(PhraseCursor::Sequence(SequenceCursor::new(parts))))
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

/// The postings of one term in `segment`, or `None` when the segment lacks the term.
pub fn term_cursor(
    segment: &SegmentReader,
    term: &Term,
    record: IndexRecordOption,
) -> tantivy::Result<Option<TokenCursor>> {
    let inverted = segment.inverted_index(term.field())?;
    Ok(inverted
        .read_postings(term, record)?
        .map(|postings| TokenCursor::Term(Box::new(postings))))
}

// A token's rows with its positions: a whole word's text term, or the text terms a prefix begins
// merged, each word's positions read only at the rows the merge stops on.
fn text_cursor(
    segment: &SegmentReader,
    fields: &IndexFields,
    token: &str,
    is_prefix: bool,
) -> tantivy::Result<Option<TokenCursor>> {
    let record = IndexRecordOption::WithFreqsAndPositions;
    if !is_prefix {
        return term_cursor(segment, &Term::from_field_text(fields.text, token), record);
    }
    let term_infos = prefix_term_infos(segment, fields.text, token)?;
    let inverted = segment.inverted_index(fields.text)?;
    word_union(&inverted, &term_infos, record)
}

/// Below one posting in this many rows of a segment, a prefix's summed postings are sorted rather
/// than added into an array as long as the segment.
const SPARSE_POSTINGS_PER_ROW: u64 = 128;

// Every text term `prefix` begins, as one token, its counts in a row summed over its words, read
// the cheaper of two ways for the rows `asked`. Sought at few rows, each word's postings are sought
// to each row, merged. Walked, or sought at more rows than seeking every word there costs against
// reading them whole, each word is read whole, a block of rows at a time, and its counts summed
// per row, so the prefix's count in a row is a lookup: every word's rows are read once, where
// merging them costs a heap step per row.
fn prefix_cursor(
    segment: &SegmentReader,
    text: Field,
    prefix: &str,
    asked: RowsAsked,
) -> tantivy::Result<Option<TokenCursor>> {
    let term_infos = prefix_term_infos(segment, text, prefix)?;
    let inverted = segment.inverted_index(text)?;
    let postings: u64 = term_infos
        .iter()
        .map(|term_info| u64::from(term_info.doc_freq))
        .sum();
    let words = term_infos.len() as u64;
    let is_sought = match asked {
        RowsAsked::Every => false,
        RowsAsked::AtMost(rows) => rows.saturating_mul(words) < postings,
    };
    if words <= 1 || is_sought {
        return word_union(&inverted, &term_infos, IndexRecordOption::WithFreqs);
    }
    let summed = if postings * SPARSE_POSTINGS_PER_ROW < u64::from(segment.max_doc()) {
        let mut entries = Vec::with_capacity(postings as usize);
        for_each_posting(&inverted, &term_infos, |doc, frequency| {
            entries.push((doc, frequency));
        })?;
        entries.sort_unstable();
        SummedRows::listed(entries)
    } else {
        let mut counts = vec![0u32; segment.max_doc() as usize];
        let mut rows = BitSet::with_max_value(segment.max_doc());
        for_each_posting(&inverted, &term_infos, |doc, frequency| {
            counts[doc as usize] += frequency;
            rows.insert(doc);
        })?;
        SummedRows::Dense {
            rows: BitSetDocSet::from(rows),
            counts,
        }
    };
    Ok(Some(TokenCursor::Summed(Box::new(summed))))
}

// The words of `term_infos` as one cursor: a lone word's postings, or every word's merged.
fn word_union(
    inverted: &InvertedIndexReader,
    term_infos: &[TermInfo],
    record: IndexRecordOption,
) -> tantivy::Result<Option<TokenCursor>> {
    let mut word_postings = Vec::with_capacity(term_infos.len());
    for term_info in term_infos {
        word_postings.push(inverted.read_postings_from_terminfo(term_info, record)?);
    }
    Ok(match word_postings.len() {
        0 => None,
        1 => word_postings
            .pop()
            .map(|postings| TokenCursor::Term(Box::new(postings))),
        _ => Some(TokenCursor::Union(UnionCursor::new(word_postings))),
    })
}

// Hands `visit` each word's rows with its count there, a term at a time, through one block reader
// reset to each term in turn.
fn for_each_posting(
    inverted: &InvertedIndexReader,
    term_infos: &[TermInfo],
    mut visit: impl FnMut(DocId, u32),
) -> tantivy::Result<()> {
    let Some((first, rest)) = term_infos.split_first() else {
        return Ok(());
    };
    let mut block =
        inverted.read_block_postings_from_terminfo(first, IndexRecordOption::WithFreqs)?;
    let mut terms = rest.iter();
    loop {
        while !block.docs().is_empty() {
            for (doc, frequency) in block.docs().iter().zip(block.freqs()) {
                visit(*doc, *frequency);
            }
            block.advance();
        }
        let Some(term_info) = terms.next() else {
            return Ok(());
        };
        inverted.reset_block_postings_from_terminfo(term_info, &mut block)?;
    }
}

// Where every term of `field` that `prefix` begins sits in `segment`'s term dictionary, in term
// order.
fn prefix_term_infos(
    segment: &SegmentReader,
    field: Field,
    prefix: &str,
) -> tantivy::Result<Vec<TermInfo>> {
    let inverted = segment.inverted_index(field)?;
    let mut stream = inverted
        .terms()
        .range()
        .ge(prefix.as_bytes())
        .into_stream()?;
    let mut term_infos = Vec::new();
    while stream.advance() && stream.key().starts_with(prefix.as_bytes()) {
        term_infos.push(stream.value().clone());
    }
    Ok(term_infos)
}

/// Whether every cursor sits on `doc`, each moved there or past it.
pub fn all_on(cursors: &mut [PhraseCursor], doc: DocId) -> bool {
    cursors.iter_mut().all(|cursor| cursor.seek(doc) == doc)
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
        let asked = RowsAsked::AtMost(asked);
        let mut filters = Vec::new();
        for phrase in phrases {
            let Some(term) = phrase.long_prefix_field_term(fields) else {
                continue;
            };
            match term_cursor(segment, &term, IndexRecordOption::Basic)? {
                Some(filter) => filters.push(filter),
                None => {
                    return Ok(GatedCursors {
                        segment,
                        fields,
                        phrases,
                        purpose,
                        asked,
                        filters,
                        cursors: GatedState::NoRowMatches,
                    });
                }
            }
        }
        Ok(GatedCursors {
            segment,
            fields,
            phrases,
            purpose,
            asked,
            filters,
            cursors: GatedState::Closed,
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

/// One token's rows: a single term's postings, the postings of every term a prefix begins merged,
/// or, where only counts are read at many rows, the terms a longer prefix begins summed per row.
pub enum TokenCursor {
    // Boxed: a term's postings hold a decoded block inline, many times a union's size.
    Term(Box<SegmentPostings>),
    Union(UnionCursor),
    Summed(Box<SummedRows>),
}

/// Every row a prefix's words hold in one segment, deleted rows included, with the words' counts
/// summed per row.
pub enum SummedRows {
    /// The rows as a bit set, and a count for every row of the segment, zero where no word is.
    Dense {
        rows: BitSetDocSet,
        counts: Vec<u32>,
    },
    /// The rows ascending, each row's count ending at its place in the running total, and the
    /// place of the current row.
    Listed {
        rows: Vec<DocId>,
        ends: Vec<u32>,
        place: usize,
    },
}

impl SummedRows {
    // From `entries` sorted by row, each a row and one word's count there.
    fn listed(entries: Vec<(DocId, u32)>) -> SummedRows {
        let mut rows: Vec<DocId> = Vec::new();
        let mut ends: Vec<u32> = Vec::new();
        let mut end = 0u32;
        for (doc, frequency) in entries {
            end += frequency;
            if rows.last() == Some(&doc) {
                if let Some(last) = ends.last_mut() {
                    *last = end;
                }
            } else {
                rows.push(doc);
                ends.push(end);
            }
        }
        SummedRows::Listed {
            rows,
            ends,
            place: 0,
        }
    }

    fn doc(&self) -> DocId {
        match self {
            SummedRows::Dense { rows, .. } => rows.doc(),
            SummedRows::Listed { rows, place, .. } => {
                rows.get(*place).copied().unwrap_or(TERMINATED)
            }
        }
    }

    fn advance(&mut self) -> DocId {
        match self {
            SummedRows::Dense { rows, .. } => rows.advance(),
            SummedRows::Listed { place, .. } => {
                *place += 1;
                self.doc()
            }
        }
    }

    fn seek(&mut self, target: DocId) -> DocId {
        match self {
            SummedRows::Dense { rows, .. } => rows.seek(target),
            SummedRows::Listed { rows, place, .. } => {
                *place += rows[(*place).min(rows.len())..].partition_point(|doc| *doc < target);
                self.doc()
            }
        }
    }

    fn frequency(&self) -> u32 {
        match self {
            SummedRows::Dense { rows, counts } => counts[rows.doc() as usize],
            SummedRows::Listed { ends, place, .. } => {
                let start = if *place == 0 { 0 } else { ends[*place - 1] };
                ends[*place] - start
            }
        }
    }

    fn rows(&self) -> u64 {
        match self {
            SummedRows::Dense { rows, .. } => u64::from(rows.size_hint()),
            SummedRows::Listed { rows, .. } => rows.len() as u64,
        }
    }
}

impl TokenCursor {
    /// The row the cursor is on, `TERMINATED` past the last.
    pub fn doc(&self) -> DocId {
        match self {
            TokenCursor::Term(postings) => postings.doc(),
            TokenCursor::Union(union) => union.doc,
            TokenCursor::Summed(summed) => summed.doc(),
        }
    }

    /// Moves to the next row.
    pub fn advance(&mut self) -> DocId {
        match self {
            TokenCursor::Term(postings) => postings.advance(),
            TokenCursor::Union(union) => union.advance(),
            TokenCursor::Summed(summed) => summed.advance(),
        }
    }

    /// Moves to the first row at or after `target`; a cursor already there stays.
    pub fn seek(&mut self, target: DocId) -> DocId {
        match self {
            TokenCursor::Term(postings) if postings.doc() >= target => postings.doc(),
            TokenCursor::Term(postings) => postings.seek(target),
            TokenCursor::Union(union) => union.seek(target),
            TokenCursor::Summed(summed) => summed.seek(target),
        }
    }

    /// How many times the token occurs in the current row.
    pub fn frequency(&mut self) -> u32 {
        match self {
            TokenCursor::Term(postings) => postings.term_freq(),
            TokenCursor::Union(union) => union
                .current
                .iter()
                .map(|index| union.postings[*index].term_freq())
                .sum(),
            TokenCursor::Summed(summed) => summed.frequency(),
        }
    }

    /// The token's positions in the current row, ascending, into `positions`.
    pub fn positions(&mut self, positions: &mut Vec<u32>) {
        positions.clear();
        match self {
            TokenCursor::Term(postings) => postings.append_positions_with_offset(0, positions),
            TokenCursor::Union(union) => {
                for index in &union.current {
                    union.postings[*index].append_positions_with_offset(0, positions);
                }
                positions.sort_unstable();
            }
            TokenCursor::Summed(_) => {
                unreachable!("a summed prefix is opened only where no positions are read")
            }
        }
    }

    /// The rows the cursor can visit, counted with deleted rows.
    pub fn cost(&self) -> u64 {
        match self {
            TokenCursor::Term(postings) => u64::from(postings.doc_freq()),
            TokenCursor::Union(union) => union
                .postings
                .iter()
                .map(|postings| u64::from(postings.doc_freq()))
                .sum(),
            TokenCursor::Summed(summed) => summed.rows(),
        }
    }
}

/// Several terms' postings merged into one ascending walk: the postings on the current row, and the
/// rest in a heap by the row each is on.
pub struct UnionCursor {
    postings: Vec<SegmentPostings>,
    waiting: BinaryHeap<Reverse<(DocId, usize)>>,
    current: Vec<usize>,
    doc: DocId,
}

impl UnionCursor {
    fn new(postings: Vec<SegmentPostings>) -> UnionCursor {
        let waiting = postings
            .iter()
            .enumerate()
            .filter(|(_, postings)| postings.doc() != TERMINATED)
            .map(|(index, postings)| Reverse((postings.doc(), index)))
            .collect();
        let mut union = UnionCursor {
            postings,
            waiting,
            current: Vec::new(),
            doc: TERMINATED,
        };
        union.settle();
        union
    }

    fn settle(&mut self) {
        self.current.clear();
        self.doc = match self.waiting.peek() {
            Some(Reverse((doc, _))) => *doc,
            None => TERMINATED,
        };
        while let Some(Reverse((doc, index))) = self.waiting.peek().copied() {
            if doc != self.doc {
                break;
            }
            self.waiting.pop();
            self.current.push(index);
        }
    }

    fn advance(&mut self) -> DocId {
        for index in &self.current {
            let next = self.postings[*index].advance();
            if next != TERMINATED {
                self.waiting.push(Reverse((next, *index)));
            }
        }
        self.settle();
        self.doc
    }

    fn seek(&mut self, target: DocId) -> DocId {
        if self.doc >= target {
            return self.doc;
        }
        for index in &self.current {
            let next = self.postings[*index].seek(target);
            if next != TERMINATED {
                self.waiting.push(Reverse((next, *index)));
            }
        }
        self.current.clear();
        while let Some(Reverse((doc, index))) = self.waiting.peek().copied() {
            if doc >= target {
                break;
            }
            self.waiting.pop();
            let next = self.postings[index].seek(target);
            if next != TERMINATED {
                self.waiting.push(Reverse((next, index)));
            }
        }
        self.settle();
        self.doc
    }
}

/// A phrase's rows: one token's, or a typed word of several tokens, whose rows hold its tokens next
/// to each other in order.
pub enum PhraseCursor {
    Token(TokenCursor),
    Sequence(SequenceCursor),
}

impl PhraseCursor {
    /// The row the cursor is on, `TERMINATED` past the last.
    pub fn doc(&self) -> DocId {
        match self {
            PhraseCursor::Token(token) => token.doc(),
            PhraseCursor::Sequence(sequence) => sequence.doc,
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
            PhraseCursor::Sequence(sequence) => sequence.parts[sequence.leader].cost(),
        }
    }
}

/// A typed word of several tokens: the rows where every token sits right after the one before,
/// walked from its rarest token.
pub struct SequenceCursor {
    parts: Vec<TokenCursor>,
    leader: usize,
    doc: DocId,
    starts: Vec<u32>,
    part_positions: Vec<Vec<u32>>,
}

impl SequenceCursor {
    fn new(parts: Vec<TokenCursor>) -> SequenceCursor {
        let leader = (0..parts.len())
            .min_by_key(|index| parts[*index].cost())
            .unwrap_or(0);
        let part_positions = vec![Vec::new(); parts.len()];
        let mut sequence = SequenceCursor {
            parts,
            leader,
            doc: TERMINATED,
            starts: Vec::new(),
            part_positions,
        };
        sequence.find_match();
        sequence
    }

    fn advance(&mut self) -> DocId {
        self.parts[self.leader].advance();
        self.find_match()
    }

    fn seek(&mut self, target: DocId) -> DocId {
        if self.doc >= target {
            return self.doc;
        }
        self.parts[self.leader].seek(target);
        self.find_match()
    }

    // From the leader's row on, the first row holding every part in order.
    fn find_match(&mut self) -> DocId {
        let mut candidate = self.parts[self.leader].doc();
        'candidates: while candidate != TERMINATED {
            for index in 0..self.parts.len() {
                let doc = self.parts[index].seek(candidate);
                if doc != candidate {
                    candidate = self.parts[self.leader].seek(doc);
                    continue 'candidates;
                }
            }
            if self.collect_starts() {
                self.doc = candidate;
                return candidate;
            }
            candidate = self.parts[self.leader].advance();
        }
        self.starts.clear();
        self.doc = TERMINATED;
        TERMINATED
    }

    // The positions where the first part starts a full run of the parts in the current row.
    fn collect_starts(&mut self) -> bool {
        for (part, positions) in self.parts.iter_mut().zip(self.part_positions.iter_mut()) {
            part.positions(positions);
        }
        self.starts.clear();
        let Some((first, rest)) = self.part_positions.split_first() else {
            return false;
        };
        for start in first {
            let in_order = rest.iter().enumerate().all(|(offset, positions)| {
                positions
                    .binary_search(&(start + offset as u32 + 1))
                    .is_ok()
            });
            if in_order {
                self.starts.push(*start);
            }
        }
        !self.starts.is_empty()
    }
}
