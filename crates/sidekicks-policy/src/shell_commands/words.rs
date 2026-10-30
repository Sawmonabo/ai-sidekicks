//! A shell word as the shell passes it to a program, held as pieces of the line it was read from
//! and of its reading's one decoded buffer: quotes removed, backslash escapes undone, ANSI-C
//! strings decoded where the shells decode them alike, and every expansion, substitution and word
//! the shell expands into file names or alternatives kept as its source text in the line. A word
//! is never copied out of its pieces, and each query on it costs the pieces it reads.

mod options;
mod quote_removal;
mod split_string;
mod unexpanded_word;

use std::fmt;
use std::sync::{Arc, OnceLock};

use memchr::{memchr, memchr_iter, memrchr};
use tree_sitter::Node;

pub use self::options::is_option;
pub(super) use self::options::{long_option_named, short_option_named};
pub(in crate::shell_commands) use self::quote_removal::decode_ansi_c;
use self::quote_removal::{unescape_bare, unescape_double_quoted};
use super::starts_variable_name;

/// `count` as a reading's offset or count: its line is within the reader's limit, a system's
/// argument bound far below 4 GiB, and its pieces and words are a small multiple of the line.
pub(super) fn offset(count: usize) -> u32 {
    u32::try_from(count).expect("a reading's offsets and counts stay below 4 GiB")
}

/// The source text `node` spans.
pub(super) fn node_text<'s>(node: Node<'_>, source: &'s str) -> &'s str {
    source
        .get(node.byte_range())
        .expect("the parser ends a node only between characters of the line it read")
}

/// What a piece holds, and so which text its range indexes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PieceKind {
    /// Text of the line that no quote or escape changes.
    Literal,
    /// An expansion, a substitution or a pattern the shell expands into file names or alternatives,
    /// or an ANSI-C string the shells decode apart, kept as its source text in the line.
    Expansion,
    /// An expansion or a substitution inside double quotes, kept as its source text in the line,
    /// which the shell splits into no further words.
    QuotedExpansion,
    /// Text an escape or an ANSI-C string decoded, in the decoded buffer.
    Decoded,
    /// A `${…}` that `env -S` expands inside decoded text, kept as that text in the decoded buffer,
    /// or text standing for the words a program reads from its input, as xargs does.
    DecodedExpansion,
}

impl PieceKind {
    // Whether the piece's text is only the run's to decide.
    fn is_expansion(self) -> bool {
        matches!(
            self,
            Self::Expansion | Self::QuotedExpansion | Self::DecodedExpansion
        )
    }

    // Whether the piece indexes the decoded buffer rather than the line.
    fn is_in_decoded(self) -> bool {
        matches!(self, Self::Decoded | Self::DecodedExpansion)
    }
}

/// A byte range of the line, or of the decoded buffer for a decoded piece.
#[derive(Clone, Copy)]
pub(super) struct Piece {
    start: u32,
    end: u32,
    kind: PieceKind,
}

/// A word: a run of the reading's pieces.
#[derive(Clone, Copy)]
pub(super) struct Word {
    first_piece: u32,
    end_piece: u32,
}

impl Word {
    fn pieces(self) -> std::ops::Range<usize> {
        self.first_piece as usize..self.end_piece as usize
    }
}

/// A byte whose positions in a line a word query looks up.
#[derive(Clone, Copy)]
pub enum PositionedByte {
    /// `/`, which ends a program's folder.
    Slash,
    /// `c`, the shell option that runs a command string.
    LetterC,
}

impl PositionedByte {
    fn byte(self) -> u8 {
        match self {
            Self::Slash => b'/',
            Self::LetterC => b'c',
        }
    }
}

/// The sorted positions of each looked-up byte in a line, each list built on its first use.
#[derive(Default)]
pub(super) struct BytePositions {
    slashes: OnceLock<Box<[u32]>>,
    letter_cs: OnceLock<Box<[u32]>>,
}

impl BytePositions {
    fn of(&self, line: &str, byte: PositionedByte) -> &[u32] {
        let list = match byte {
            PositionedByte::Slash => &self.slashes,
            PositionedByte::LetterC => &self.letter_cs,
        };
        list.get_or_init(|| {
            memchr_iter(byte.byte(), line.as_bytes())
                .map(offset)
                .collect()
        })
    }
}

/// The texts a reading's pieces index.
#[derive(Clone, Copy)]
pub(super) struct PieceTexts<'r> {
    line: &'r str,
    decoded: &'r str,
    positions: &'r BytePositions,
}

impl<'r> PieceTexts<'r> {
    /// The texts of a reading of `line`.
    pub(super) fn new(line: &'r str, decoded: &'r str, positions: &'r BytePositions) -> Self {
        Self {
            line,
            decoded,
            positions,
        }
    }

    fn text(self, piece: Piece) -> &'r str {
        let source = if piece.kind.is_in_decoded() {
            self.decoded
        } else {
            self.line
        };
        &source[piece.start as usize..piece.end as usize]
    }

    // The position of the last `byte` in `piece`, in the text the piece indexes.
    fn last_position(self, piece: Piece, byte: PositionedByte) -> Option<u32> {
        if piece.kind.is_in_decoded() {
            return memrchr(byte.byte(), self.text(piece).as_bytes())
                .map(|position| piece.start + offset(position));
        }
        let positions = self.positions.of(self.line, byte);
        let after = positions.partition_point(|&position| position < piece.end);
        after
            .checked_sub(1)
            .map(|index| positions[index])
            .filter(|&position| position >= piece.start)
    }

    fn contains(self, piece: Piece, byte: PositionedByte) -> bool {
        if piece.kind.is_in_decoded() {
            return memchr(byte.byte(), self.text(piece).as_bytes()).is_some();
        }
        let positions = self.positions.of(self.line, byte);
        let first = positions.partition_point(|&position| position < piece.start);
        positions
            .get(first)
            .is_some_and(|&position| position < piece.end)
    }
}

/// A word's text as the option walks read it, for a word of a reading and a plain string alike.
pub trait WordText: Copy {
    /// Whether the word is exactly `text`.
    fn is(self, text: &str) -> bool;
    /// Whether the word starts with `prefix`.
    fn starts_with(self, prefix: &str) -> bool;
    /// The word's characters, read only as far as the caller takes them.
    fn chars(self) -> impl Iterator<Item = char>;
    /// Whether `byte` occurs in the word.
    fn contains(self, byte: PositionedByte) -> bool;
    /// Whether the shell passes the word as its text reads; a plain string always is.
    fn is_decided(self) -> bool;
    /// Whether the word stands for words its text spells beside its own, which a reading counts
    /// wherever one of them would match; a plain string never does.
    fn spells_alternatives(self) -> bool;
}

impl WordText for &str {
    fn is(self, text: &str) -> bool {
        self == text
    }

    fn starts_with(self, prefix: &str) -> bool {
        str::starts_with(self, prefix)
    }

    fn chars(self) -> impl Iterator<Item = char> {
        str::chars(self)
    }

    fn contains(self, byte: PositionedByte) -> bool {
        memchr(byte.byte(), self.as_bytes()).is_some()
    }

    fn is_decided(self) -> bool {
        true
    }

    fn spells_alternatives(self) -> bool {
        false
    }
}

/// A word of a reading, read through its pieces; `Display` writes its text.
#[derive(Clone, Copy)]
pub struct ShellWord<'r> {
    texts: PieceTexts<'r>,
    pieces: &'r [Piece],
}

impl<'r> ShellWord<'r> {
    /// The word `word` of a reading with these texts and pieces.
    pub(super) fn new(texts: PieceTexts<'r>, pieces: &'r [Piece], word: Word) -> Self {
        Self {
            texts,
            pieces: &pieces[word.pieces()],
        }
    }

    /// The word's length in bytes, summed from its pieces.
    pub(crate) fn len(self) -> usize {
        self.pieces
            .iter()
            .map(|piece| (piece.end - piece.start) as usize)
            .sum()
    }

    /// The word's text, one chunk per piece.
    pub(crate) fn chunks(self) -> impl Iterator<Item = &'r str> {
        self.pieces.iter().map(move |&piece| self.texts.text(piece))
    }

    /// Whether the shell passes the word as read here: false when an expansion, a substitution, a
    /// pattern or an ANSI-C string the shells decode apart makes its text, which only the line's
    /// run decides and which can split it into several words, any of them an option.
    pub fn is_decided(self) -> bool {
        self.pieces.iter().all(|piece| !piece.kind.is_expansion())
    }

    /// Whether the word's first `bytes` bytes are passed as read here, none of them made by an
    /// expansion, a substitution, a pattern or an ANSI-C string the shells decode apart.
    pub(crate) fn is_decided_through(self, bytes: usize) -> bool {
        let mut start = 0;
        self.pieces.iter().all(|piece| {
            let is_decided = start >= bytes || !piece.kind.is_expansion();
            start += (piece.end - piece.start) as usize;
            is_decided
        })
    }

    /// Whether part of the word is an expansion, a substitution or a pattern outside double
    /// quotes, which the shell can split or expand into several words, an ANSI-C string the
    /// shells decode apart, or a `${…}` that `env -S` expands, however the line spelled it; a word
    /// whose only undecided parts are double-quoted stays one word.
    pub(crate) fn holds_unquoted_expansion(self) -> bool {
        self.pieces.iter().any(|piece| {
            matches!(
                piece.kind,
                PieceKind::Expansion | PieceKind::DecodedExpansion
            )
        })
    }

    /// Whether the word stands for words its text spells beside its own: a brace expansion's
    /// alternatives, an ANSI-C string bash and zsh decode apart, or the words a program hands its
    /// command from its input, as xargs does. A parameter, a substitution, an arithmetic
    /// expansion, zsh's `=name` or a file-name pattern spells none: only the run decides it.
    pub fn spells_alternatives(self) -> bool {
        self.pieces
            .iter()
            .any(|&piece| piece.kind.is_expansion() && !is_run_decided(self.texts.text(piece)))
    }
}

impl WordText for ShellWord<'_> {
    fn is(self, text: &str) -> bool {
        self.len() == text.len() && chunks_start_with(self.chunks(), text)
    }

    fn starts_with(self, prefix: &str) -> bool {
        chunks_start_with(self.chunks(), prefix)
    }

    fn chars(self) -> impl Iterator<Item = char> {
        self.chunks().flat_map(str::chars)
    }

    fn contains(self, byte: PositionedByte) -> bool {
        self.pieces
            .iter()
            .any(|&piece| self.texts.contains(piece, byte))
    }

    fn is_decided(self) -> bool {
        ShellWord::is_decided(self)
    }

    fn spells_alternatives(self) -> bool {
        ShellWord::spells_alternatives(self)
    }
}

impl fmt::Display for ShellWord<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.chunks()
            .try_for_each(|chunk| formatter.write_str(chunk))
    }
}

// Whether the text the chunks hold in order starts with `prefix`.
fn chunks_start_with<'a>(chunks: impl Iterator<Item = &'a str>, prefix: &str) -> bool {
    let mut rest = prefix.as_bytes();
    for chunk in chunks {
        if rest.is_empty() {
            return true;
        }
        let compared = rest.len().min(chunk.len());
        if chunk.as_bytes()[..compared] != rest[..compared] {
            return false;
        }
        rest = &rest[compared..];
    }
    rest.is_empty()
}

/// Words of a reading joined by single spaces, as `eval` joins its words, past their first
/// `skipped_bytes` bytes; one word alone is the string a shell's `-c` runs, and one past an
/// option's name the value `su --command=…` hands a shell.
#[derive(Clone, Copy)]
pub(super) struct JoinedWords<'r> {
    texts: PieceTexts<'r>,
    pieces: &'r [Piece],
    words: &'r [Word],
    skipped_bytes: usize,
}

impl<'r> JoinedWords<'r> {
    /// The words `words` of a reading with these texts and pieces, past their first
    /// `skipped_bytes` bytes, which end on a character's boundary.
    pub(super) fn new(
        texts: PieceTexts<'r>,
        pieces: &'r [Piece],
        words: &'r [Word],
        skipped_bytes: usize,
    ) -> Self {
        Self {
            texts,
            pieces,
            words,
            skipped_bytes,
        }
    }

    fn chunks(self) -> impl Iterator<Item = &'r str> {
        let mut bytes_to_skip = self.skipped_bytes;
        self.words
            .iter()
            .enumerate()
            .flat_map(move |(index, &word)| {
                let separator = (index > 0).then_some(" ");
                separator
                    .into_iter()
                    .chain(ShellWord::new(self.texts, self.pieces, word).chunks())
            })
            .filter_map(move |chunk| {
                let skipped = bytes_to_skip.min(chunk.len());
                bytes_to_skip -= skipped;
                let rest = &chunk[skipped..];
                (!rest.is_empty()).then_some(rest)
            })
    }
}

/// A string the reader reads: a line, or the words a command hands a shell.
pub(super) trait ShellText: Copy {
    /// The string's length in bytes, read without building it.
    fn len(self) -> usize;
    /// Whether the string is exactly `line`.
    fn is(self, line: &str) -> bool;
    /// The string as a line a reading owns.
    fn to_line(self) -> Arc<str>;
}

impl ShellText for &str {
    fn len(self) -> usize {
        str::len(self)
    }

    fn is(self, line: &str) -> bool {
        self == line
    }

    fn to_line(self) -> Arc<str> {
        Arc::from(self)
    }
}

impl ShellText for JoinedWords<'_> {
    fn len(self) -> usize {
        let words = self
            .words
            .iter()
            .map(|&word| ShellWord::new(self.texts, self.pieces, word).len());
        words.sum::<usize>() + self.words.len().saturating_sub(1) - self.skipped_bytes
    }

    fn is(self, line: &str) -> bool {
        self.len() == line.len() && chunks_start_with(self.chunks(), line)
    }

    fn to_line(self) -> Arc<str> {
        let mut chunks = self.chunks();
        match (chunks.next(), chunks.next()) {
            // One chunk goes into the line with no string built first.
            (Some(only), None) => Arc::from(only),
            (None, _) => Arc::from(""),
            (Some(first), Some(second)) => {
                let mut line = String::with_capacity(self.len());
                line.push_str(first);
                line.push_str(second);
                chunks.for_each(|chunk| line.push_str(chunk));
                Arc::from(line)
            }
        }
    }
}

/// Builds the words of one line as pieces of it and of one decoded buffer.
pub(super) struct WordBuilder<'s> {
    line: &'s str,
    decoded: String,
    pieces: Vec<Piece>,
    positions: BytePositions,
    // The bytes `env -S` splits may still read, the line's length at the start, and whether a
    // split was left unread for want of them.
    split_bytes_left: usize,
    is_split_past_bound: bool,
}

impl<'s> WordBuilder<'s> {
    /// A builder for the words of `line`.
    pub(super) fn new(line: &'s str) -> Self {
        Self {
            line,
            decoded: String::new(),
            pieces: Vec::new(),
            positions: BytePositions::default(),
            split_bytes_left: line.len(),
            is_split_past_bound: false,
        }
    }

    /// The line the words are read from.
    pub(super) fn line(&self) -> &'s str {
        self.line
    }

    /// The decoded buffer, the pieces and the byte positions, for the reading to own, and
    /// whether an `env -S` split was left unread past the bound on what the splits read.
    pub(super) fn finish(self) -> (Box<str>, Box<[Piece]>, BytePositions, bool) {
        (
            self.decoded.into_boxed_str(),
            self.pieces.into_boxed_slice(),
            self.positions,
            self.is_split_past_bound,
        )
    }

    /// The word `word` as the queries read it.
    pub(super) fn view(&self, word: Word) -> ShellWord<'_> {
        let texts = PieceTexts::new(self.line, &self.decoded, &self.positions);
        ShellWord::new(texts, &self.pieces, word)
    }

    /// How many pieces are built, a mark `truncate` goes back to.
    pub(super) fn piece_count(&self) -> usize {
        self.pieces.len()
    }

    /// Drops the pieces built after `mark`, those of words no command keeps.
    pub(super) fn truncate(&mut self, mark: usize) {
        self.pieces.truncate(mark);
    }

    /// Reads the literal `node` as a word: a concatenation joins its parts, and every kind no
    /// quoting or escape changes reads as its text, but for zsh's `=name` at the word's start,
    /// which zsh expands into the path of the program `name`.
    pub(super) fn push_word(&mut self, node: Node<'_>) -> Word {
        let first_piece = self.pieces.len();
        let first_part = if node.kind() == "concatenation" {
            node.child(0)
        } else {
            Some(node)
        };
        let is_equals_expansion = first_part.is_some_and(|part| {
            let mut characters = node_text(part, self.line).chars();
            part.kind() == "word"
                && characters.next() == Some('=')
                && characters.next().is_some_and(starts_variable_name)
        });
        if node.kind() == "concatenation" {
            let mut cursor = node.walk();
            if cursor.goto_first_child() {
                loop {
                    self.push_part(cursor.node());
                    if !cursor.goto_next_sibling() {
                        break;
                    }
                }
            }
        } else {
            self.push_part(node);
        }
        if is_equals_expansion && let Some(piece) = self.pieces.get_mut(first_piece) {
            piece.kind = undecided_kind(piece.kind);
        }
        word_from(&self.pieces, first_piece)
    }

    /// Reads the assignment `node`, `NAME=value` or `NAME+=value`, as one word: its name and
    /// operator as their text, then its value as `push_word` reads a word.
    pub(super) fn push_assignment(&mut self, node: Node<'_>) -> Word {
        let first_piece = self.pieces.len();
        let value = node.child_by_field_name("value");
        let name_end = value.map_or(node.end_byte(), |value| value.start_byte());
        self.push_line(node.start_byte()..name_end, PieceKind::Literal);
        if let Some(value) = value {
            self.push_word(value);
        }
        word_from(&self.pieces, first_piece)
    }

    /// A word standing for the words a program reads from its input and appends to its command,
    /// as xargs does: `{}` in the decoded buffer, whose words only the run decides.
    pub(super) fn push_input_word(&mut self) -> Word {
        let first_piece = self.pieces.len();
        let start = offset(self.decoded.len());
        self.decoded.push_str("{}");
        let end = offset(self.decoded.len());
        push_piece(&mut self.pieces, start, end, PieceKind::DecodedExpansion);
        word_from(&self.pieces, first_piece)
    }

    /// `word` with every piece one only the run decides, as a word holding the string xargs
    /// replaces with its input's words is.
    pub(super) fn push_undecided_copy(&mut self, word: Word) -> Word {
        let first_piece = self.pieces.len();
        for index in word.pieces() {
            let piece = self.pieces[index];
            self.pieces.push(Piece {
                kind: undecided_kind(piece.kind),
                ..piece
            });
        }
        word_from(&self.pieces, first_piece)
    }

    /// The word's name without its folder, the text past its last `/`, and whether the folder
    /// holds a `$` expansion outside double quotes, a parameter, a substitution or an arithmetic
    /// expansion, which the shell can split into a program and its words; a pattern or a brace in
    /// the folder changes no name, and a name past a pattern's last `/` holding no pattern itself
    /// is decided. zsh's `=name` names the path of the program `name`, so its name is the text
    /// past the `=`. `None` when the word names no folder.
    pub(super) fn basename(&mut self, word: Word) -> Option<(Word, bool)> {
        let texts = PieceTexts::new(self.line, &self.decoded, &self.positions);
        let Some((index, slash)) = word.pieces().rev().find_map(|index| {
            texts
                .last_position(self.pieces[index], PositionedByte::Slash)
                .map(|slash| (index, slash))
        }) else {
            let first = word.first_piece as usize;
            let piece = *self
                .pieces
                .get(first)
                .filter(|_| first < word.end_piece as usize)?;
            let name = texts.text(piece).strip_prefix('=')?;
            let is_equals_name = piece.kind == PieceKind::Expansion
                && !name
                    .bytes()
                    .any(|byte| NAME_UNDECIDING_BYTES.contains(&byte));
            return is_equals_name.then(|| {
                (
                    self.word_from_inside(word, first, piece.start + 1, PieceKind::Literal),
                    false,
                )
            });
        };
        let can_folder_split = self.pieces[word.first_piece as usize..index]
            .iter()
            .any(|&piece| is_dollar_expansion(texts, piece));
        let piece = self.pieces[index];
        let name = Piece {
            start: slash + 1,
            ..piece
        };
        let is_name_plain = piece.kind == PieceKind::Expansion
            && !texts
                .text(name)
                .bytes()
                .any(|byte| NAME_UNDECIDING_BYTES.contains(&byte));
        let name_kind = if is_name_plain {
            PieceKind::Literal
        } else {
            piece.kind
        };
        Some((
            self.word_from_inside(word, index, slash + 1, name_kind),
            can_folder_split,
        ))
    }

    /// The word's text past its first `bytes` bytes, as an option's value attached to it is;
    /// `None` when nothing is left.
    pub(super) fn word_after(&mut self, word: Word, bytes: usize) -> Option<Word> {
        let mut skipped = 0;
        let index = word.pieces().find(|&index| {
            let piece = self.pieces[index];
            skipped += (piece.end - piece.start) as usize;
            skipped > bytes
        })?;
        let piece = self.pieces[index];
        let start = piece.end - offset(skipped - bytes);
        Some(self.word_from_inside(word, index, start, piece.kind))
    }

    // The rest of `word` from `start` inside its piece at `index`, that rest of the piece read as
    // `kind`, as a word of its own.
    fn word_from_inside(&mut self, word: Word, index: usize, start: u32, kind: PieceKind) -> Word {
        let first_piece = self.pieces.len();
        let piece = self.pieces[index];
        push_piece(&mut self.pieces, start, piece.end, kind);
        self.pieces
            .extend_from_within(index + 1..word.end_piece as usize);
        word_from(&self.pieces, first_piece)
    }

    fn push_line(&mut self, range: std::ops::Range<usize>, kind: PieceKind) {
        push_piece(
            &mut self.pieces,
            offset(range.start),
            offset(range.end),
            kind,
        );
    }

    // Decoded text `decode` writes, as one piece of the decoded buffer.
    fn push_decoded(&mut self, decode: impl FnOnce(&mut String)) {
        let start = offset(self.decoded.len());
        decode(&mut self.decoded);
        let end = offset(self.decoded.len());
        push_piece(&mut self.pieces, start, end, PieceKind::Decoded);
    }

    // An ANSI-C string, `$'…'` at `range` of the line: decoded where bash and zsh decode it alike,
    // else kept as its source text, which only the shell running the line decides.
    fn push_ansi_c(&mut self, range: std::ops::Range<usize>) {
        let line = self.line;
        let body = &line[range.start + 2..range.end];
        let decoded_mark = self.decoded.len();
        if decode_ansi_c(body, &mut self.decoded) {
            let start = offset(decoded_mark);
            push_piece(
                &mut self.pieces,
                start,
                offset(self.decoded.len()),
                PieceKind::Decoded,
            );
        } else {
            self.decoded.truncate(decoded_mark);
            self.push_line(range, PieceKind::Expansion);
        }
    }

    fn push_part(&mut self, node: Node<'_>) {
        // A node the parser supplied for a missing token spans nothing.
        if node.is_missing() {
            return;
        }
        let range = node.byte_range();
        let text = node_text(node, self.line);
        match node.kind() {
            // A pattern anywhere in the word, zsh's `^` among them, can expand into any number of
            // file names, so the shell may pass several words, any of them an option.
            "word" if has_unescaped_pattern(text) => {
                self.push_line(range, PieceKind::Expansion);
            }
            "word" if memchr(b'\\', text.as_bytes()).is_some() => {
                self.push_decoded(|value| unescape_bare(text, value));
            }
            "raw_string" if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') => {
                self.push_line(range.start + 1..range.end - 1, PieceKind::Literal);
            }
            "ansi_c_string" => self.push_ansi_c(range),
            "string" => self.push_double_quoted(node),
            // `$"…"` is a double-quoted string translated by the locale, which is not applied here.
            "translated_string" => match node.named_child(0) {
                Some(string) => self.push_part(string),
                None => self.push_line(range, PieceKind::Literal),
            },
            "simple_expansion"
            | "expansion"
            | "command_substitution"
            | "process_substitution"
            | "arithmetic_expansion"
            | "brace_expression"
            | "extglob_pattern" => self.push_line(range, PieceKind::Expansion),
            _ => self.push_line(range, PieceKind::Literal),
        }
    }

    // A double-quoted string: its text between the quotes with the escapes double quotes undo, and
    // its expansions and substitutions as their text. The text is read from the line, since a line
    // break inside the quotes is no token of the string's own.
    fn push_double_quoted(&mut self, string: Node<'_>) {
        let mut position = string.start_byte() + 1;
        let mut end = string.end_byte();
        let mut cursor = string.walk();
        if cursor.goto_first_child() {
            loop {
                let child = cursor.node();
                match child.kind() {
                    "expansion"
                    | "simple_expansion"
                    | "command_substitution"
                    | "arithmetic_expansion" => {
                        self.push_double_quoted_text(position..child.start_byte());
                        self.push_line(child.byte_range(), PieceKind::QuotedExpansion);
                        position = child.end_byte();
                    }
                    // The closing quote's token can start at the blanks after a line break, so
                    // the text ends at its last byte; a missing quote spans nothing.
                    "\"" if !child.is_missing() && child.start_byte() > string.start_byte() => {
                        end = child.end_byte() - 1;
                    }
                    _ => {}
                }
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
        }
        self.push_double_quoted_text(position..end.max(position));
    }

    fn push_double_quoted_text(&mut self, range: std::ops::Range<usize>) {
        let line = self.line;
        let text = &line[range.clone()];
        if memchr(b'\\', text.as_bytes()).is_some() {
            self.push_decoded(|value| unescape_double_quoted(text, value));
        } else {
            self.push_line(range, PieceKind::Literal);
        }
    }
}

// The word of the pieces from `first_piece` to the last one built.
fn word_from(pieces: &[Piece], first_piece: usize) -> Word {
    Word {
        first_piece: offset(first_piece),
        end_piece: offset(pieces.len()),
    }
}

// The kind of `kind`'s text when only the run decides it.
fn undecided_kind(kind: PieceKind) -> PieceKind {
    if kind.is_in_decoded() {
        PieceKind::DecodedExpansion
    } else {
        PieceKind::Expansion
    }
}

// Whether `piece` is a `$` expansion the shell can split: a parameter, a substitution or an
// arithmetic expansion outside double quotes, never an ANSI-C string.
fn is_dollar_expansion(texts: PieceTexts<'_>, piece: Piece) -> bool {
    let text = texts.text(piece);
    matches!(
        piece.kind,
        PieceKind::Expansion | PieceKind::DecodedExpansion
    ) && ((text.starts_with('$') && !text.starts_with("$'")) || text.starts_with('`'))
}

// Whether only the run decides the text of an undecided piece: a parameter, a substitution or an
// arithmetic expansion, a process substitution, zsh's `=name`, or a file-name pattern with no
// brace alternatives in it.
fn is_run_decided(text: &str) -> bool {
    (text.starts_with('$') && !text.starts_with("$'"))
        || text.starts_with(['`', '<', '>', '='])
        || (!text.contains('{') && (has_unescaped_pattern(text) || text.contains('(')))
}

// The bytes that leave a name past a pattern word's last `/` undecided: a pattern of its own, the
// end of a group, quote or substitution that spans the `/`, or an escape.
const NAME_UNDECIDING_BYTES: &[u8] = b"*?[]{}()^\\'\"$`";

// A piece of the range, unless it is empty: no piece is.
fn push_piece(pieces: &mut Vec<Piece>, start: u32, end: u32, kind: PieceKind) {
    if start < end {
        pieces.push(Piece { start, end, kind });
    }
}

// Whether an unquoted word holds a pattern character no backslash escapes: a glob's `*`, `?` or
// `[`, a brace expansion's `{`, or zsh's `^`, which negates the pattern after it.
fn has_unescaped_pattern(text: &str) -> bool {
    let mut bytes = text.bytes();
    while let Some(byte) = bytes.next() {
        match byte {
            b'\\' => {
                bytes.next();
            }
            b'*' | b'?' | b'[' | b'{' | b'^' => return true,
            _ => {}
        }
    }
    false
}
