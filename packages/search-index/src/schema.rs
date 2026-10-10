//! The index's fields, how a row becomes a document, and how owners are kept apart. A row is
//! folded into tokens once, as its document is made; every text field holds those tokens joined,
//! and the tokenizers registered here split them again as the field is indexed, so a document
//! waiting for the indexing thread holds one short string per field. Besides each token and its
//! prefixes, each token's start is indexed with the next token's, so the rows where two tokens sit
//! in order are one term's. A tag row also holds its
//! tag's fold in the tag field, cut at each `/` so a `tag:` term finds the tags nested under it,
//! and its session's last activity, which orders a search by tag alone.

use std::iter::Peekable;
use std::str::Split;

use tantivy::schema::{
    Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions,
};
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use tantivy::{Index, TantivyDocument, Term};

use crate::IndexRowKind;
use crate::tokenizer::{TextToken, prefix_of, tokenize};

/// The longest prefix with a field of its own; a longer prefix merges the whole-word terms it
/// begins.
pub const PREFIX_FIELD_COUNT: usize = 4;

/// A token no typed word can produce. It stands for a word shorter than a prefix field's length and
/// closes every row in every text field, so each field's token count is the row's length: its token
/// count plus one, the length BM25 normalizes by.
const FILLER: &str = "\u{1}";

/// Separates the joined tokens a text field holds; no folded token holds it.
const TOKEN_SEPARATOR: char = '\u{0}';

/// Separates a token's start from the next one's in a pair term; no folded token holds it.
const PAIR_SEPARATOR: &str = " ";

/// The tokenizer the text field is indexed with.
const TOKENS_TOKENIZER: &str = "joined-tokens";

/// The tokenizer the tag field is indexed with.
const TAG_PATHS_TOKENIZER: &str = "tag-paths";

/// Separates a tag's levels.
const TAG_LEVEL_SEPARATOR: char = '/';

/// The kind code an `event` row carries in the kind column.
pub const EVENT_KIND: u64 = 0;

/// The index's fields. The index stores no text: every field is indexed or a column.
#[derive(Clone, Copy, Debug)]
pub struct IndexFields {
    /// Each row's folded tokens with frequencies and positions, then the filler.
    pub text: Field,
    /// `prefixes[n - 1]` holds each token's first n characters, or the filler for a shorter token.
    pub prefixes: [Field; PREFIX_FIELD_COUNT],
    /// At each token's place, the token's first four characters, or all of a shorter one, then
    /// the next place's token's the same way, with frequencies and positions; the filler where no
    /// token is next.
    pub pair: Field,
    /// The row key, indexed so a replace or a removal deletes by its term.
    pub key: Field,
    /// The row's owner as `owner_value` encodes it, indexed so an owner's rows are found by term.
    pub owner: Field,
    pub kind: Field,
    /// The row's length: its token count plus one.
    pub length: Field,
    /// A tag row's fold and the fold of each tag it is nested under: `billing/stripe` holds
    /// `billing` and `billing/stripe`.
    pub tag: Field,
    /// A tag row's session's last activity, in milliseconds since the Unix epoch.
    pub activity: Field,
}

/// The index's schema and its fields.
pub fn index_schema() -> (Schema, IndexFields) {
    let mut builder = Schema::builder();
    let text_indexing = text_options(IndexRecordOption::WithFreqsAndPositions, TOKENS_TOKENIZER);
    let text = builder.add_text_field("text", text_indexing);
    let prefixes = std::array::from_fn(|index| {
        let name = format!("prefix{}", index + 1);
        let tokenizer = tokenizer_name(TokenCut::Prefix(index + 1));
        builder.add_text_field(
            &name,
            text_options(IndexRecordOption::WithFreqs, &tokenizer),
        )
    });
    let pair = builder.add_text_field(
        "pair",
        text_options(
            IndexRecordOption::WithFreqsAndPositions,
            &tokenizer_name(TokenCut::Pair),
        ),
    );
    let key = builder.add_u64_field("key", NumericOptions::default().set_indexed().set_fast());
    let owner = builder.add_u64_field("owner", NumericOptions::default().set_indexed().set_fast());
    let kind = builder.add_u64_field("kind", NumericOptions::default().set_fast());
    let length = builder.add_u64_field("length", NumericOptions::default().set_fast());
    // No row is scored by its tag, so the tag field keeps no lengths.
    let tag_indexing = TextFieldIndexing::default()
        .set_tokenizer(TAG_PATHS_TOKENIZER)
        .set_index_option(IndexRecordOption::Basic)
        .set_fieldnorms(false);
    let tag = builder.add_text_field(
        "tag",
        TextOptions::default().set_indexing_options(tag_indexing),
    );
    let activity = builder.add_u64_field("activity", NumericOptions::default().set_fast());
    (
        builder.build(),
        IndexFields {
            text,
            prefixes,
            pair,
            key,
            owner,
            kind,
            length,
            tag,
            activity,
        },
    )
}

fn text_options(record: IndexRecordOption, tokenizer: &str) -> TextOptions {
    TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(tokenizer)
            .set_index_option(record),
    )
}

// The tokenizer a prefix or pair field is indexed with.
fn tokenizer_name(cut: TokenCut) -> String {
    match cut {
        TokenCut::Whole => TOKENS_TOKENIZER.to_string(),
        TokenCut::Prefix(length) => format!("joined-prefixes-{length}"),
        TokenCut::Pair => "joined-pairs".to_string(),
    }
}

/// Registers the tokenizers the schema's text fields name, which an index needs before its writer
/// indexes a row.
pub fn register_tokenizers(index: &Index) {
    let tokenizers = index.tokenizers();
    let mut cuts = vec![TokenCut::Whole, TokenCut::Pair];
    cuts.extend((1..=PREFIX_FIELD_COUNT).map(TokenCut::Prefix));
    for cut in cuts {
        tokenizers.register(&tokenizer_name(cut), JoinedTokens { cut });
    }
    tokenizers.register(TAG_PATHS_TOKENIZER, TagPaths);
}

/// Whose rows a row is: a session's own, or a group's name row, which counts toward its members.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Session(u64),
    Group(u64),
}

/// The number the owner field holds: session and group keys share one number space, so a session
/// key is stored doubled and a group key doubled plus one.
pub fn owner_value(owner: Owner) -> u64 {
    match owner {
        Owner::Session(key) => key * 2,
        Owner::Group(key) => key * 2 + 1,
    }
}

/// The owner an owner field value names.
pub fn owner_of(value: u64) -> Owner {
    if value.is_multiple_of(2) {
        Owner::Session(value / 2)
    } else {
        Owner::Group(value / 2)
    }
}

fn kind_code(kind: &IndexRowKind) -> u64 {
    match kind {
        IndexRowKind::Event => EVENT_KIND,
        IndexRowKind::Title => 1,
        IndexRowKind::Group => 2,
        IndexRowKind::Tag => 3,
    }
}

/// The term a row key is deleted by.
pub fn key_term(fields: &IndexFields, key: u64) -> Term {
    Term::from_field_u64(fields.key, key)
}

/// The term every row of an owner carries.
pub fn owner_term(fields: &IndexFields, owner: Owner) -> Term {
    Term::from_field_u64(fields.owner, owner_value(owner))
}

/// The pair field's text for `token` followed by `next`, each cut to its first four characters.
pub fn pair_text(token: &str, next: &str) -> String {
    format!("{}{PAIR_SEPARATOR}{}", pair_start(token), pair_start(next))
}

// A token's start as the pair field holds it.
fn pair_start(token: &str) -> &str {
    prefix_of(token, PREFIX_FIELD_COUNT).unwrap_or(token)
}

/// The term a tag field holds for every tag row whose tag is `fold` or nested under it.
pub fn tag_term(fields: &IndexFields, fold: &str) -> Term {
    Term::from_field_text(fields.tag, fold)
}

/// One row as a document: its folded tokens in the text field, their prefixes and pairs in the
/// prefix and pair fields, and its key, owner, kind and length as columns; a tag row's fold and its
/// session's last activity besides.
pub fn row_document(
    fields: &IndexFields,
    key: u64,
    kind: &IndexRowKind,
    owner: Owner,
    text: &str,
    tag: Option<(&str, u64)>,
) -> TantivyDocument {
    let tokens = tokenize(text);
    let joined = joined_tokens(&tokens);
    let mut document = TantivyDocument::default();
    document.add_text(fields.text, &joined);
    for field in fields.prefixes.into_iter().chain([fields.pair]) {
        document.add_text(field, &joined);
    }
    document.add_u64(fields.key, key);
    document.add_u64(fields.owner, owner_value(owner));
    document.add_u64(fields.kind, kind_code(kind));
    document.add_u64(fields.length, tokens.len() as u64 + 1);
    if let Some((fold, activity)) = tag {
        document.add_text(fields.tag, fold);
        document.add_u64(fields.activity, activity);
    }
    document
}

// The folded tokens in place order, joined by the separator, a dropped token's place left empty
// between them: the n-th piece is the token at place n.
fn joined_tokens(tokens: &[TextToken]) -> String {
    let mut joined = String::new();
    let mut place = 0;
    for token in tokens {
        while place < token.position {
            joined.push(TOKEN_SEPARATOR);
            place += 1;
        }
        joined.push_str(&token.folded);
    }
    joined
}

/// Splits a text field's joined tokens back into tokens at their places, each cut as its field
/// holds it, then the filler past the last place, so every field holds the row's length in tokens.
#[derive(Clone)]
struct JoinedTokens {
    cut: TokenCut,
}

/// What a field holds at each token's place.
#[derive(Clone, Copy)]
enum TokenCut {
    /// The token.
    Whole,
    /// Its first n characters, or the filler for a shorter token.
    Prefix(usize),
    /// Its start and the next place's token's start, each its first four characters, or the
    /// filler where the next place holds no token.
    Pair,
}

impl Tokenizer for JoinedTokens {
    type TokenStream<'a> = JoinedTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> JoinedTokenStream<'a> {
        let mut pieces = text.split(TOKEN_SEPARATOR);
        // An empty text holds no token, not one empty piece.
        if text.is_empty() {
            pieces.next();
        }
        JoinedTokenStream {
            pieces: pieces.peekable(),
            cut: self.cut,
            place: 0,
            is_filler_sent: false,
            token: Token::default(),
        }
    }
}

struct JoinedTokenStream<'a> {
    pieces: Peekable<Split<'a, char>>,
    cut: TokenCut,
    place: usize,
    is_filler_sent: bool,
    token: Token,
}

impl JoinedTokenStream<'_> {
    fn emit(&mut self, pieces: &[&str], position: usize) {
        self.token.text.clear();
        for piece in pieces {
            self.token.text.push_str(piece);
        }
        self.token.position = position;
        self.token.position_length = 1;
    }
}

impl TokenStream for JoinedTokenStream<'_> {
    fn advance(&mut self) -> bool {
        while let Some(piece) = self.pieces.next() {
            let place = self.place;
            self.place += 1;
            if piece.is_empty() {
                continue;
            }
            match self.cut {
                TokenCut::Whole => self.emit(&[piece], place),
                TokenCut::Prefix(length) => {
                    self.emit(&[prefix_of(piece, length).unwrap_or(FILLER)], place);
                }
                TokenCut::Pair => {
                    // An empty next piece is a dropped token's place: no token is next.
                    match self.pieces.peek().filter(|next| !next.is_empty()) {
                        Some(next) => {
                            let next_start = pair_start(next);
                            self.emit(&[pair_start(piece), PAIR_SEPARATOR, next_start], place);
                        }
                        None => self.emit(&[FILLER], place),
                    }
                }
            }
            return true;
        }
        if self.is_filler_sent {
            return false;
        }
        self.is_filler_sent = true;
        self.emit(&[FILLER], self.place);
        true
    }

    fn token(&self) -> &Token {
        &self.token
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}

/// Splits a tag's fold into the fold of each level from the first: `billing/stripe` gives
/// `billing`, then `billing/stripe`.
#[derive(Clone)]
struct TagPaths;

impl Tokenizer for TagPaths {
    type TokenStream<'a> = TagPathStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> TagPathStream<'a> {
        TagPathStream {
            fold: text,
            next_end: (!text.is_empty()).then_some(0),
            position: 0,
            token: Token::default(),
        }
    }
}

struct TagPathStream<'a> {
    fold: &'a str,
    // Where the search for the next level's end starts; `None` once the whole fold was sent.
    next_end: Option<usize>,
    position: usize,
    token: Token,
}

impl TokenStream for TagPathStream<'_> {
    fn advance(&mut self) -> bool {
        let Some(from) = self.next_end else {
            return false;
        };
        let end = match self.fold[from..].find(TAG_LEVEL_SEPARATOR) {
            Some(offset) => {
                self.next_end = Some(from + offset + 1);
                from + offset
            }
            None => {
                self.next_end = None;
                self.fold.len()
            }
        };
        self.token.text.clear();
        self.token.text.push_str(&self.fold[..end]);
        self.token.position = self.position;
        self.position += 1;
        self.token.offset_from = 0;
        self.token.offset_to = end;
        self.token.position_length = 1;
        true
    }

    fn token(&self) -> &Token {
        &self.token
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}
