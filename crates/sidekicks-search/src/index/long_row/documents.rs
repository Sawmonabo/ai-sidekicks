//! A row longer than a page cut into its documents as its pages arrive: each page its own document,
//! and each page boundary one edge document holding the places on either side that a query's phrase
//! can span, so a phrase across the boundary matches there.

use std::collections::VecDeque;

use crate::index::IndexRowKind;
use crate::index::schema::{RowPiece, joined_tokens};
use crate::index::tokenizer::{EDGE_PLACES, tokenize_with_places};

/// One document of a row longer than a page, as the index takes it: a page or an edge document,
/// its tokens already folded.
#[derive(Clone, Debug)]
pub struct LongRowDocument {
    /// The row's key, which every document of the row carries.
    pub(crate) key: u64,
    /// What the row holds.
    pub(crate) kind: IndexRowKind,
    /// The row's owner key, as an `IndexRow` carries it.
    pub(crate) owner_key: u64,
    /// Which piece of the row it is and where it sits.
    pub(crate) piece: RowPiece,
    /// Its tokens joined as a text field holds them.
    pub(crate) joined: String,
    /// How many tokens it holds.
    pub(crate) token_count: usize,
}

/// Cuts a row longer than a page into its documents, its pages handed in order. It holds the
/// tokens of at most the last edge's reach of places of the page before each boundary still
/// waiting for as many places after it, and those places, so a row of any length costs one page
/// and that tail.
#[derive(Debug)]
pub struct LongRowDocuments {
    key: u64,
    kind: IndexRowKind,
    owner_key: u64,
    // The row's place of the next page's first place.
    next_place: u32,
    // The last page's place count; `None` before the first page.
    last_page_places: Option<u32>,
    // The folded tokens of the places an open edge or the next boundary's edge needs, by place.
    window: VecDeque<(u32, String)>,
    // The edges still short of the places after their boundary, oldest first: each one's first
    // place and its boundary.
    open_edges: VecDeque<(u32, u32)>,
}

impl LongRowDocuments {
    /// The documents of the row at `key`, of `kind`, owned by `owner_key`, before its first page.
    pub fn new(key: u64, kind: IndexRowKind, owner_key: u64) -> LongRowDocuments {
        LongRowDocuments {
            key,
            kind,
            owner_key,
            next_place: 0,
            last_page_places: None,
            window: VecDeque::new(),
            open_edges: VecDeque::new(),
        }
    }

    /// Takes the row's next page, which begins where the last one ended, never inside a word:
    /// hands `emit` the page's document, then each edge document the page completes.
    pub fn add_page(&mut self, text: &str, emit: &mut impl FnMut(LongRowDocument)) {
        let (tokens, places) = tokenize_with_places(text);
        let start = self.next_place;
        // A boundary after a page with no place cannot be crossed: a phrase across it crosses an
        // earlier one, whose edge counts it.
        if let Some(last_places) = self.last_page_places.filter(|places| *places > 0) {
            self.open_edges
                .push_back((start - last_places.min(EDGE_PLACES), start));
        }
        let joined = joined_tokens(
            tokens
                .iter()
                .map(|token| (token.position, token.folded.as_str())),
        );
        emit(self.document(RowPiece::Page { place: start }, joined, tokens.len()));
        self.next_place = start + places;
        self.last_page_places = Some(places);
        let tail_start = self.next_place.saturating_sub(EDGE_PLACES).max(start);
        let reach_end = self
            .open_edges
            .back()
            .map_or(start, |(_, boundary)| boundary + EDGE_PLACES);
        self.window.extend(tokens.into_iter().filter_map(|token| {
            let place = start + token.position;
            (place < reach_end || place >= tail_start).then_some((place, token.folded))
        }));
        while let Some(&(first, boundary)) = self.open_edges.front() {
            if boundary + EDGE_PLACES > self.next_place {
                break;
            }
            self.open_edges.pop_front();
            self.emit_edge(first, boundary, emit);
        }
        let kept_from = self
            .open_edges
            .front()
            .map_or(tail_start, |(first, _)| (*first).min(tail_start));
        while self
            .window
            .front()
            .is_some_and(|(place, _)| *place < kept_from)
        {
            self.window.pop_front();
        }
    }

    /// Ends the row: hands `emit` each edge document still open, holding what places the row has
    /// after its boundary.
    pub fn finish(mut self, emit: &mut impl FnMut(LongRowDocument)) {
        while let Some((first, boundary)) = self.open_edges.pop_front() {
            self.emit_edge(first, boundary, emit);
        }
    }

    // The edge from `first` with its boundary at `boundary`, through the edge's reach after it,
    // when it holds a token on each side; an edge without one matches nothing across it.
    fn emit_edge(&self, first: u32, boundary: u32, emit: &mut impl FnMut(LongRowDocument)) {
        let end = boundary + EDGE_PLACES;
        let tokens: Vec<&(u32, String)> = self
            .window
            .iter()
            .filter(|(place, _)| (first..end).contains(place))
            .collect();
        let has_both_sides = tokens.first().is_some_and(|(place, _)| *place < boundary)
            && tokens.last().is_some_and(|(place, _)| *place >= boundary);
        if !has_both_sides {
            return;
        }
        let joined = joined_tokens(
            tokens
                .iter()
                .map(|(place, folded)| (place - first, folded.as_str())),
        );
        emit(self.document(
            RowPiece::Edge {
                place: first,
                boundary,
            },
            joined,
            tokens.len(),
        ));
    }

    fn document(&self, piece: RowPiece, joined: String, token_count: usize) -> LongRowDocument {
        LongRowDocument {
            key: self.key,
            kind: self.kind,
            owner_key: self.owner_key,
            piece,
            joined,
            token_count,
        }
    }
}
