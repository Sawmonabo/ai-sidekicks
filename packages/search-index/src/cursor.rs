//! Cursors over the rows a phrase matches in one segment, with how often it matches each row.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use tantivy::postings::{Postings, SegmentPostings, TermInfo};
use tantivy::query::{BooleanWeight, Explanation, Occur, Scorer, SumCombiner, Weight};
use tantivy::schema::{Field, IndexRecordOption};
use tantivy::{DocId, DocSet, Score, SegmentReader, TERMINATED, TantivyError, Term};

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
            (CursorPurpose::Score, None) => occurrences_cursor(segment, fields.text, part)?,
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

// A prefix longer than every prefix field, for scoring: Tantivy's buffered union of every word it
// begins, merging them a window of rows at a time rather than seeking each word's postings to every
// row asked for, each word scored by its count in the row so the union's score is the prefix's.
fn occurrences_cursor(
    segment: &SegmentReader,
    text: Field,
    prefix: &str,
) -> tantivy::Result<Option<TokenCursor>> {
    let term_infos = prefix_term_infos(segment, text, prefix)?;
    let cost = term_infos
        .iter()
        .map(|term_info| u64::from(term_info.doc_freq))
        .sum();
    let words: Vec<(Occur, Box<dyn Weight>)> = term_infos
        .into_iter()
        .map(|term_info| {
            let word = OccurrenceWeight { text, term_info };
            (Occur::Should, Box::new(word) as Box<dyn Weight>)
        })
        .collect();
    if words.is_empty() {
        return Ok(None);
    }
    let union = BooleanWeight::new(words, true, Box::new(SumCombiner::default));
    let words = union.scorer(segment, 1.0)?;
    Ok(Some(TokenCursor::Occurrences { words, cost }))
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

// One word's postings, scored by how often the word occurs in each row.
struct OccurrenceWeight {
    text: Field,
    term_info: TermInfo,
}

impl Weight for OccurrenceWeight {
    fn scorer(&self, segment: &SegmentReader, _: Score) -> tantivy::Result<Box<dyn Scorer>> {
        let postings = segment
            .inverted_index(self.text)?
            .read_postings_from_terminfo(&self.term_info, IndexRecordOption::WithFreqs)?;
        Ok(Box::new(OccurrenceScorer(postings)))
    }

    fn explain(&self, segment: &SegmentReader, doc: DocId) -> tantivy::Result<Explanation> {
        let mut scorer = self.scorer(segment, 1.0)?;
        if scorer.seek(doc) != doc {
            return Err(TantivyError::InvalidArgument(format!(
                "row {doc} does not hold the word"
            )));
        }
        Ok(Explanation::new("occurrences in the row", scorer.score()))
    }
}

struct OccurrenceScorer(SegmentPostings);

impl DocSet for OccurrenceScorer {
    fn advance(&mut self) -> DocId {
        self.0.advance()
    }

    fn seek(&mut self, target: DocId) -> DocId {
        self.0.seek(target)
    }

    fn doc(&self) -> DocId {
        self.0.doc()
    }

    fn size_hint(&self) -> u32 {
        self.0.size_hint()
    }
}

impl Scorer for OccurrenceScorer {
    fn score(&mut self) -> Score {
        self.0.term_freq() as Score
    }
}

/// The four-character prefix field's postings of each phrase that is a prefix longer than every
/// prefix field. They hold every row the prefix's words hold, so a row they lack is turned away
/// before the words' merged postings are sought to it, a seek that refills a window of rows. Rows
/// are asked in increasing order.
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
/// their positions, or for scoring alone those terms' union scored by their counts.
pub enum TokenCursor {
    // Boxed: a term's postings hold a decoded block inline, many times a union's size.
    Term(Box<SegmentPostings>),
    Union(UnionCursor),
    // Tantivy's union leaves a word out of its own cost once it has passed the word's last row, so
    // the words' rows are counted when it opens.
    Occurrences { words: Box<dyn Scorer>, cost: u64 },
}

impl TokenCursor {
    /// The row the cursor is on, `TERMINATED` past the last.
    pub fn doc(&self) -> DocId {
        match self {
            TokenCursor::Term(postings) => postings.doc(),
            TokenCursor::Union(union) => union.doc,
            TokenCursor::Occurrences { words, .. } => words.doc(),
        }
    }

    /// Moves to the next row.
    pub fn advance(&mut self) -> DocId {
        match self {
            TokenCursor::Term(postings) => postings.advance(),
            TokenCursor::Union(union) => union.advance(),
            TokenCursor::Occurrences { words, .. } => words.advance(),
        }
    }

    /// Moves to the first row at or after `target`; a cursor already there stays.
    pub fn seek(&mut self, target: DocId) -> DocId {
        match self {
            TokenCursor::Term(postings) if postings.doc() >= target => postings.doc(),
            TokenCursor::Term(postings) => postings.seek(target),
            TokenCursor::Union(union) => union.seek(target),
            TokenCursor::Occurrences { words, .. } => words.seek(target),
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
            // Each word's count summed as a float, exact for any count a row can hold.
            TokenCursor::Occurrences { words, .. } => words.score() as u32,
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
            TokenCursor::Occurrences { .. } => {}
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
            TokenCursor::Occurrences { cost, .. } => *cost,
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
