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

/// Opens `phrase`'s cursor in `segment`, or `None` when no row of the segment can match it.
pub fn open_phrase_cursor(
    segment: &SegmentReader,
    fields: &IndexFields,
    phrase: &Phrase,
    purpose: CursorPurpose,
) -> tantivy::Result<Option<PhraseCursor>> {
    if let [part] = phrase.parts.as_slice() {
        let token = match (purpose, phrase.single_term(fields)) {
            (CursorPurpose::Score, Some(term)) => {
                term_cursor(segment, &term, IndexRecordOption::WithFreqs)?
            }
            (CursorPurpose::Score, None) => summed_cursor(segment, fields.text, part)?,
            (CursorPurpose::Mark, _) => text_cursor(
                segment,
                fields,
                part,
                phrase.ends_in_prefix,
                IndexRecordOption::WithFreqsAndPositions,
            )?,
        };
        return Ok(token.map(PhraseCursor::Token));
    }
    let mut parts = Vec::with_capacity(phrase.parts.len());
    for (index, part) in phrase.parts.iter().enumerate() {
        let record = IndexRecordOption::WithFreqsAndPositions;
        match text_cursor(segment, fields, part, phrase.is_prefix_part(index), record)? {
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
) -> tantivy::Result<Option<Vec<PhraseCursor>>> {
    let mut cursors = Vec::with_capacity(phrases.len());
    for phrase in phrases {
        match open_phrase_cursor(segment, fields, phrase, purpose)? {
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

// A whole word's text term, or every text term a prefix begins, merged.
fn text_cursor(
    segment: &SegmentReader,
    fields: &IndexFields,
    token: &str,
    is_prefix: bool,
    record: IndexRecordOption,
) -> tantivy::Result<Option<TokenCursor>> {
    if !is_prefix {
        return term_cursor(segment, &Term::from_field_text(fields.text, token), record);
    }
    let inverted = segment.inverted_index(fields.text)?;
    let mut postings = Vec::new();
    for term_info in prefix_term_infos(segment, fields.text, token)? {
        postings.push(inverted.read_postings_from_terminfo(&term_info, record)?);
    }
    Ok(match postings.len() {
        0 => None,
        1 => postings
            .pop()
            .map(|postings| TokenCursor::Term(Box::new(postings))),
        _ => Some(TokenCursor::Union(UnionCursor::new(postings))),
    })
}

/// Below one posting in this many rows of a segment, a long prefix's postings are sorted rather
/// than summed into an array as long as the segment.
const SPARSE_POSTINGS_PER_ROW: u64 = 128;

// A prefix longer than every prefix field, for scoring: each word it begins read whole, a block of
// rows at a time, its counts summed per row, so the prefix's count in a row is a lookup. Every
// word's rows are read once, where merging them a row at a time costs a heap step or a refilled
// window per row asked.
fn summed_cursor(
    segment: &SegmentReader,
    text: Field,
    prefix: &str,
) -> tantivy::Result<Option<TokenCursor>> {
    let term_infos = prefix_term_infos(segment, text, prefix)?;
    if term_infos.is_empty() {
        return Ok(None);
    }
    let inverted = segment.inverted_index(text)?;
    let postings: u64 = term_infos
        .iter()
        .map(|term_info| u64::from(term_info.doc_freq))
        .sum();
    let summed = if postings * SPARSE_POSTINGS_PER_ROW < u64::from(segment.max_doc()) {
        let mut pairs = Vec::with_capacity(postings as usize);
        for_each_posting(&inverted, &term_infos, |doc, frequency| {
            pairs.push((doc, frequency));
        })?;
        pairs.sort_unstable_by_key(|(doc, _)| *doc);
        let mut rows: Vec<DocId> = Vec::with_capacity(pairs.len());
        let mut counts: Vec<u32> = Vec::with_capacity(pairs.len());
        for (doc, frequency) in pairs {
            match (rows.last(), counts.last_mut()) {
                (Some(last), Some(count)) if *last == doc => *count += frequency,
                _ => {
                    rows.push(doc);
                    counts.push(frequency);
                }
            }
        }
        SummedRows::Sparse {
            rows,
            counts,
            place: 0,
        }
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

// Hands `visit` each row and count of every term in `term_infos`, a term at a time, through one
// block reader reset to each term in turn.
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

/// The four-character prefix field's postings of each phrase that is a prefix longer than every
/// prefix field. They hold every row the prefix's words hold, so a row they lack is turned away
/// before the phrases' cursors are opened or sought to it: a long prefix's cursor reads every word
/// it begins. Rows are asked in increasing order.
pub struct RowFilters(Vec<TokenCursor>);

impl RowFilters {
    /// The filters of `phrases` in `segment`; a phrase with none, or one the segment lacks, filters
    /// nothing, and its own cursor finds no row there.
    pub fn open(
        segment: &SegmentReader,
        fields: &IndexFields,
        phrases: &[Phrase],
    ) -> tantivy::Result<RowFilters> {
        let mut filters = Vec::new();
        for phrase in phrases {
            let Some(term) = phrase.long_prefix_field_term(fields) else {
                continue;
            };
            if let Some(filter) = term_cursor(segment, &term, IndexRecordOption::Basic)? {
                filters.push(filter);
            }
        }
        Ok(RowFilters(filters))
    }

    /// Whether row `doc` can match every phrase: false when a filter lacks it.
    pub fn admit(&mut self, doc: DocId) -> bool {
        self.0.iter_mut().all(|filter| filter.seek(doc) == doc)
    }
}

/// One token's rows: a single term's postings, the postings of every term a prefix begins with
/// their positions, or for scoring alone those terms' counts summed per row.
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
    /// The rows ascending with their counts, and the place of the current one.
    Sparse {
        rows: Vec<DocId>,
        counts: Vec<u32>,
        place: usize,
    },
}

impl SummedRows {
    fn doc(&self) -> DocId {
        match self {
            SummedRows::Dense { rows, .. } => rows.doc(),
            SummedRows::Sparse { rows, place, .. } => {
                rows.get(*place).copied().unwrap_or(TERMINATED)
            }
        }
    }

    fn advance(&mut self) -> DocId {
        match self {
            SummedRows::Dense { rows, .. } => rows.advance(),
            SummedRows::Sparse { place, .. } => {
                *place += 1;
                self.doc()
            }
        }
    }

    fn seek(&mut self, target: DocId) -> DocId {
        match self {
            SummedRows::Dense { rows, .. } => rows.seek(target),
            SummedRows::Sparse { rows, place, .. } => {
                *place += rows[(*place).min(rows.len())..].partition_point(|doc| *doc < target);
                self.doc()
            }
        }
    }

    fn frequency(&self) -> u32 {
        match self {
            SummedRows::Dense { rows, counts } => counts[rows.doc() as usize],
            SummedRows::Sparse { counts, place, .. } => counts[*place],
        }
    }

    fn rows(&self) -> u64 {
        match self {
            SummedRows::Dense { rows, .. } => u64::from(rows.size_hint()),
            SummedRows::Sparse { rows, .. } => rows.len() as u64,
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
            // Opened for scoring, so no position is read.
            TokenCursor::Summed(_) => {}
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
