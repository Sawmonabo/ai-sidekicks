//! One token's rows in one segment, with its count and places in each: a term's postings, a
//! prefix's words merged, or a long prefix's words summed per row.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use tantivy::postings::{Postings, SegmentPostings, TermInfo};
use tantivy::query::BitSetDocSet;
use tantivy::schema::{Field, IndexRecordOption};
use tantivy::{DocId, DocSet, InvertedIndexReader, SegmentReader, TERMINATED, Term};
use tantivy_common::BitSet;

use super::RowsAsked;
use crate::schema::{IndexFields, PREFIX_FIELD_COUNT};

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
pub(super) fn text_cursor(
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
    word_union(segment, fields.text, &term_infos, record)
}

/// Below one posting in this many rows of a segment, a prefix's summed postings are sorted rather
/// than added into an array as long as the segment.
const SPARSE_POSTINGS_PER_ROW: u64 = 128;

// The terms of `field` in `term_infos`, every one a prefix begins, as one token, its counts in a
// row summed over them, read the cheaper of two ways for the rows `asked`. Sought at few rows, each
// term's postings are sought to each row, merged. Walked, or sought at more rows than seeking every
// term there costs against reading them whole, each term is read whole, a block of rows at a time,
// and its counts summed per row, so the prefix's count in a row is a lookup: every term's rows are
// read once, where merging them costs a heap step per row.
pub(super) fn prefix_cursor(
    segment: &SegmentReader,
    field: Field,
    term_infos: &[TermInfo],
    asked: RowsAsked,
) -> tantivy::Result<Option<TokenCursor>> {
    let inverted = segment.inverted_index(field)?;
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
        return word_union(segment, field, term_infos, IndexRecordOption::WithFreqs);
    }
    let summed = if postings * SPARSE_POSTINGS_PER_ROW < u64::from(segment.max_doc()) {
        let mut entries = Vec::with_capacity(postings as usize);
        for_each_posting(&inverted, term_infos, |doc, frequency| {
            entries.push((doc, frequency));
        })?;
        entries.sort_unstable();
        SummedRows::listed(entries)
    } else {
        let mut counts = vec![0u32; segment.max_doc() as usize];
        let mut rows = BitSet::with_max_value(segment.max_doc());
        for_each_posting(&inverted, term_infos, |doc, frequency| {
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

// The words of `field` in `term_infos` as one cursor: a lone word's postings, or every word's
// merged.
pub(super) fn word_union(
    segment: &SegmentReader,
    field: Field,
    term_infos: &[TermInfo],
    record: IndexRecordOption,
) -> tantivy::Result<Option<TokenCursor>> {
    let inverted = segment.inverted_index(field)?;
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

// A long prefix's words in a segment's text: `Pinned` where its first four characters, the cut a
// prefix field or pair term holds, begin no word it does not, so a term holding the cut holds
// exactly the prefix's places; otherwise every word it begins, in term order.
pub(super) enum PrefixWords {
    Pinned,
    Listed(Vec<TermInfo>),
}

impl PrefixWords {
    // One walk of the term dictionary from the cut: the prefix's words are one run among the cut's,
    // so the walk ends at the first word past that run.
    pub(super) fn read(
        segment: &SegmentReader,
        fields: &IndexFields,
        prefix: &str,
    ) -> tantivy::Result<PrefixWords> {
        let cut: String = prefix.chars().take(PREFIX_FIELD_COUNT).collect();
        if cut == prefix {
            return Ok(PrefixWords::Pinned);
        }
        let inverted = segment.inverted_index(fields.text)?;
        let mut stream = inverted.terms().range().ge(cut.as_bytes()).into_stream()?;
        let mut term_infos = Vec::new();
        let mut begins_others = false;
        while stream.advance() && stream.key().starts_with(cut.as_bytes()) {
            if stream.key().starts_with(prefix.as_bytes()) {
                term_infos.push(stream.value().clone());
            } else {
                begins_others = true;
                if !term_infos.is_empty() {
                    break;
                }
            }
        }
        Ok(if begins_others {
            PrefixWords::Listed(term_infos)
        } else {
            PrefixWords::Pinned
        })
    }
}

// Where every term of `field` that `prefix` begins sits in `segment`'s term dictionary, in term
// order.
pub(super) fn prefix_term_infos(
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
    /// The rows ascending, each row's count, and the place of the current row.
    Listed {
        rows: Vec<DocId>,
        counts: Vec<u32>,
        place: usize,
    },
}

impl SummedRows {
    // From `entries` sorted by row, each a row and one word's count there.
    fn listed(entries: Vec<(DocId, u32)>) -> SummedRows {
        let mut rows: Vec<DocId> = Vec::new();
        let mut counts: Vec<u32> = Vec::new();
        for (doc, frequency) in entries {
            match counts.last_mut() {
                Some(count) if rows.last() == Some(&doc) => *count += frequency,
                _ => {
                    rows.push(doc);
                    counts.push(frequency);
                }
            }
        }
        SummedRows::Listed {
            rows,
            counts,
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
            SummedRows::Listed { counts, place, .. } => counts[*place],
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
