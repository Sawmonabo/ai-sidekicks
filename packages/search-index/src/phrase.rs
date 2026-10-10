//! A query's phrases: each typed word tokenized and folded as the index folds text.

use tantivy::Term;

use crate::SearchQuery;
use crate::schema::{IndexFields, PREFIX_FIELD_COUNT, pair_text};
use crate::tokenizer::tokenize;

/// Where the pair field holds the rows of two neighboring tokens: one term, or every term a text
/// begins when the second token is a prefix shorter than the field cuts tokens to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairRows {
    Term(Term),
    Prefix(String),
}

/// One typed word as the index matches it: its folded tokens, which must sit next to each other in
/// a row, the last one matched as a prefix while the word is still being typed.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Phrase {
    pub parts: Vec<String>,
    pub ends_in_prefix: bool,
}

/// The query's phrases in typed order; a word with no letter or digit in it is no phrase.
pub fn query_phrases(query: &SearchQuery) -> Vec<Phrase> {
    let last = query.words.len().saturating_sub(1);
    query
        .words
        .iter()
        .enumerate()
        .filter_map(|(index, word)| {
            let parts: Vec<String> = tokenize(word)
                .into_iter()
                .map(|token| token.folded)
                .collect();
            let ends_in_prefix = query.last_word_is_prefix && index == last;
            (!parts.is_empty()).then_some(Phrase {
                parts,
                ends_in_prefix,
            })
        })
        .collect()
}

impl Phrase {
    /// Whether part `index` matches as a prefix.
    pub fn is_prefix_part(&self, index: usize) -> bool {
        self.ends_in_prefix && index + 1 == self.parts.len()
    }

    /// Whether `token` matches part `index`.
    pub fn part_matches(&self, index: usize, token: &str) -> bool {
        if self.is_prefix_part(index) {
            token.starts_with(&self.parts[index])
        } else {
            token == self.parts[index]
        }
    }

    /// The one term that holds exactly this phrase's rows and counts, when one does: a whole word's
    /// text term, a prefix field's term for a prefix of up to four characters, or the pair term of
    /// a token the pair field holds whole followed by a four-character prefix or a whole token the
    /// field holds whole.
    pub fn single_term(&self, fields: &IndexFields) -> Option<Term> {
        match self.parts.as_slice() {
            [part] if !self.ends_in_prefix => Some(Term::from_field_text(fields.text, part)),
            [part] => {
                let length = part.chars().count();
                (length <= PREFIX_FIELD_COUNT)
                    .then(|| Term::from_field_text(fields.prefixes[length - 1], part))
            }
            [_, _] => match self.exact_pair_rows(fields)? {
                PairRows::Term(term) => Some(term),
                PairRows::Prefix(_) => None,
            },
            _ => None,
        }
    }

    /// For two tokens whose rows and counts the pair field holds exactly, where those are: the
    /// first token shorter than the field's cut, the second a prefix of at most that many
    /// characters or a whole token shorter than it, so every term matched is one place where the
    /// two sit in order.
    pub fn exact_pair_rows(&self, fields: &IndexFields) -> Option<PairRows> {
        let [token, next] = self.parts.as_slice() else {
            return None;
        };
        let next_length = next.chars().count();
        let is_exact = token.chars().count() < PREFIX_FIELD_COUNT
            && if self.ends_in_prefix {
                next_length <= PREFIX_FIELD_COUNT
            } else {
                next_length < PREFIX_FIELD_COUNT
            };
        is_exact.then(|| pair_rows(fields, token, next, self.is_prefix_part(1)))
    }

    /// For a one-token prefix longer than every prefix field, the longest prefix field's term for
    /// its first characters: it holds every row the prefix matches, at least as many times.
    pub fn long_prefix_field_term(&self, fields: &IndexFields) -> Option<Term> {
        let [part] = self.parts.as_slice() else {
            return None;
        };
        (self.ends_in_prefix && part.chars().count() > PREFIX_FIELD_COUNT)
            .then(|| prefix_field_term(fields, part))
    }

    /// Terms that each hold every row the phrase matches, at least as many times: its own term, the
    /// longest prefix field's term for a longer prefix, or for several tokens each whole one's, a
    /// prefix field's term for the last when it is a prefix, and each pair of neighbors' term.
    pub fn covering_terms(&self, fields: &IndexFields) -> Vec<Term> {
        if let Some(term) = self
            .single_term(fields)
            .or_else(|| self.long_prefix_field_term(fields))
        {
            return vec![term];
        }
        let mut terms: Vec<Term> = (0..self.parts.len())
            .map(|index| {
                let part = &self.parts[index];
                if self.is_prefix_part(index) {
                    prefix_field_term(fields, part)
                } else {
                    Term::from_field_text(fields.text, part)
                }
            })
            .collect();
        terms.extend(
            self.pair_rows(fields)
                .into_iter()
                .filter_map(|rows| match rows {
                    PairRows::Term(term) => Some(term),
                    PairRows::Prefix(_) => None,
                }),
        );
        terms
    }

    /// For each two neighboring tokens, where the pair field holds every row the two sit in order
    /// in, at least as many times.
    pub fn pair_rows(&self, fields: &IndexFields) -> Vec<PairRows> {
        (1..self.parts.len())
            .map(|index| {
                let (token, next) = (&self.parts[index - 1], &self.parts[index]);
                pair_rows(fields, token, next, self.is_prefix_part(index))
            })
            .collect()
    }

    /// Whether one token can match both this one-token phrase and `other`, so it could be marked
    /// twice.
    pub fn can_share_a_token_with(&self, other: &Phrase) -> bool {
        let (Some(mine), Some(theirs)) = (self.parts.first(), other.parts.first()) else {
            return false;
        };
        match (self.ends_in_prefix, other.ends_in_prefix) {
            (false, false) => mine == theirs,
            (true, false) => theirs.starts_with(mine.as_str()),
            (false, true) => mine.starts_with(theirs.as_str()),
            (true, true) => mine.starts_with(theirs.as_str()) || theirs.starts_with(mine.as_str()),
        }
    }
}

// Where the pair field holds `token` followed by `next`: a prefix shorter than the field's cut
// begins several terms, and anything else is one.
fn pair_rows(fields: &IndexFields, token: &str, next: &str, is_prefix: bool) -> PairRows {
    let text = pair_text(token, next);
    if is_prefix && next.chars().count() < PREFIX_FIELD_COUNT {
        PairRows::Prefix(text)
    } else {
        PairRows::Term(Term::from_field_text(fields.pair, &text))
    }
}

// The prefix field's term for `part`'s first characters, as many as the longest field holds.
fn prefix_field_term(fields: &IndexFields, part: &str) -> Term {
    let start = field_start(part);
    Term::from_field_text(fields.prefixes[start.chars().count() - 1], &start)
}

// `part`'s first characters, as many as the longest prefix field holds.
fn field_start(part: &str) -> String {
    part.chars().take(PREFIX_FIELD_COUNT).collect()
}
