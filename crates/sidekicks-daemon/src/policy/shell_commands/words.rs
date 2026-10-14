//! A shell word as the shell passes it to a program, held as pieces of the line it was read from
//! and of its reading's one decoded buffer: quotes removed, backslash escapes undone, ANSI-C strings
//! decoded, and every expansion and substitution kept as its source text in the line. A word is
//! never copied out of its pieces, and each query on it costs the pieces it reads.

use std::fmt;
use std::sync::{Arc, OnceLock};

use memchr::{memchr, memchr_iter, memrchr};
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use tree_sitter::Node;

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
    /// An expansion or a substitution, kept as its source text in the line.
    Expansion,
    /// Text an escape or an ANSI-C string decoded, in the decoded buffer.
    Decoded,
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
pub(crate) enum PositionedByte {
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
        let source = match piece.kind {
            PieceKind::Literal | PieceKind::Expansion => self.line,
            PieceKind::Decoded => self.decoded,
        };
        &source[piece.start as usize..piece.end as usize]
    }

    // The position of the last `byte` in `piece`, in the text the piece indexes.
    fn last_position(self, piece: Piece, byte: PositionedByte) -> Option<u32> {
        match piece.kind {
            PieceKind::Literal | PieceKind::Expansion => {
                let positions = self.positions.of(self.line, byte);
                let after = positions.partition_point(|&position| position < piece.end);
                after
                    .checked_sub(1)
                    .map(|index| positions[index])
                    .filter(|&position| position >= piece.start)
            }
            PieceKind::Decoded => memrchr(byte.byte(), self.text(piece).as_bytes())
                .map(|position| piece.start + offset(position)),
        }
    }

    fn contains(self, piece: Piece, byte: PositionedByte) -> bool {
        match piece.kind {
            PieceKind::Literal | PieceKind::Expansion => {
                let positions = self.positions.of(self.line, byte);
                let first = positions.partition_point(|&position| position < piece.start);
                positions
                    .get(first)
                    .is_some_and(|&position| position < piece.end)
            }
            PieceKind::Decoded => memchr(byte.byte(), self.text(piece).as_bytes()).is_some(),
        }
    }
}

/// A word's text as the option walks read it, for a word of a reading and a plain string alike.
pub(crate) trait WordText: Copy {
    /// Whether the word is exactly `text`.
    fn is(self, text: &str) -> bool;
    /// Whether the word starts with `prefix`.
    fn starts_with(self, prefix: &str) -> bool;
    /// The word's characters, read only as far as the caller takes them.
    fn chars(self) -> impl Iterator<Item = char>;
    /// Whether `byte` occurs in the word.
    fn contains(self, byte: PositionedByte) -> bool;
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
}

/// A word of a reading, read through its pieces; `Display` writes its text.
#[derive(Clone, Copy)]
pub(crate) struct ShellWord<'r> {
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

/// Words of a reading joined by single spaces, as `eval` joins its words; one word alone is the
/// string a shell's `-c` runs.
#[derive(Clone, Copy)]
pub(super) struct JoinedWords<'r> {
    texts: PieceTexts<'r>,
    pieces: &'r [Piece],
    words: &'r [Word],
}

impl<'r> JoinedWords<'r> {
    /// The words `words` of a reading with these texts and pieces.
    pub(super) fn new(texts: PieceTexts<'r>, pieces: &'r [Piece], words: &'r [Word]) -> Self {
        Self {
            texts,
            pieces,
            words,
        }
    }

    fn chunks(self) -> impl Iterator<Item = &'r str> {
        self.words
            .iter()
            .enumerate()
            .flat_map(move |(index, &word)| {
                let separator = (index > 0).then_some(" ");
                separator
                    .into_iter()
                    .chain(ShellWord::new(self.texts, self.pieces, word).chunks())
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
        words.sum::<usize>() + self.words.len().saturating_sub(1)
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
}

impl<'s> WordBuilder<'s> {
    /// A builder for the words of `line`.
    pub(super) fn new(line: &'s str) -> Self {
        Self {
            line,
            decoded: String::new(),
            pieces: Vec::new(),
            positions: BytePositions::default(),
        }
    }

    /// The line the words are read from.
    pub(super) fn line(&self) -> &'s str {
        self.line
    }

    /// The decoded buffer, the pieces and the byte positions, for the reading to own.
    pub(super) fn finish(self) -> (Box<str>, Box<[Piece]>, BytePositions) {
        (
            self.decoded.into_boxed_str(),
            self.pieces.into_boxed_slice(),
            self.positions,
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
    /// quoting or escape changes reads as its text.
    pub(super) fn push_word(&mut self, node: Node<'_>) -> Word {
        let first_piece = self.pieces.len();
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
        word_from(&self.pieces, first_piece)
    }

    /// The word's name without its folder: the text past its last `/`, the word itself when it
    /// has none.
    pub(super) fn basename(&mut self, word: Word) -> Word {
        let texts = PieceTexts::new(self.line, &self.decoded, &self.positions);
        let Some((index, slash)) = word.pieces().rev().find_map(|index| {
            texts
                .last_position(self.pieces[index], PositionedByte::Slash)
                .map(|slash| (index, slash))
        }) else {
            return word;
        };
        let first_piece = self.pieces.len();
        let piece = self.pieces[index];
        push_piece(&mut self.pieces, slash + 1, piece.end, piece.kind);
        self.pieces
            .extend_from_within(index + 1..word.end_piece as usize);
        word_from(&self.pieces, first_piece)
    }

    /// The words `env -S` splits `word` into: split on whitespace only inside its literal and
    /// decoded pieces, so an expansion or substitution stays inside one word.
    pub(super) fn split_on_whitespace(&mut self, word: Word) -> Vec<Word> {
        let Self {
            line,
            decoded,
            pieces,
            ..
        } = self;
        let mut words = Vec::new();
        let mut first_piece = pieces.len();
        for index in word.pieces() {
            let piece = pieces[index];
            let text = match piece.kind {
                PieceKind::Expansion => {
                    pieces.push(piece);
                    continue;
                }
                PieceKind::Literal => &line[piece.start as usize..piece.end as usize],
                PieceKind::Decoded => &decoded[piece.start as usize..piece.end as usize],
            };
            let mut run_start = piece.start;
            for (position, character) in text.char_indices() {
                if !is_ecmascript_whitespace(character) {
                    continue;
                }
                let position = piece.start + offset(position);
                push_piece(pieces, run_start, position, piece.kind);
                if pieces.len() > first_piece {
                    words.push(word_from(pieces, first_piece));
                    first_piece = pieces.len();
                }
                run_start = position + offset(character.len_utf8());
            }
            push_piece(pieces, run_start, piece.end, piece.kind);
        }
        if pieces.len() > first_piece {
            words.push(word_from(pieces, first_piece));
        }
        words
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

    fn push_part(&mut self, node: Node<'_>) {
        // A node the parser supplied for a missing token spans nothing.
        if node.is_missing() {
            return;
        }
        let range = node.byte_range();
        let text = node_text(node, self.line);
        match node.kind() {
            "word" if memchr(b'\\', text.as_bytes()).is_some() => {
                self.push_decoded(|value| unescape_bare(text, value));
            }
            "raw_string" if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') => {
                self.push_line(range.start + 1..range.end - 1, PieceKind::Literal);
            }
            "ansi_c_string" => {
                let body = text.strip_prefix("$'").unwrap_or(text);
                self.push_decoded(|value| decode_ansi_c(body, value));
            }
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
            | "arithmetic_expansion" => self.push_line(range, PieceKind::Expansion),
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
                        self.push_line(child.byte_range(), PieceKind::Expansion);
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

// A piece of the range, unless it is empty: no piece is.
fn push_piece(pieces: &mut Vec<Piece>, start: u32, end: u32, kind: PieceKind) {
    if start < end {
        pieces.push(Piece { start, end, kind });
    }
}

// An unquoted word: each backslash keeps the character after it, a backslash and a line break go
// together, and a backslash ending the word stays.
fn unescape_bare(text: &str, value: &mut String) {
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            value.push(character);
            continue;
        }
        match characters.next() {
            None => value.push('\\'),
            Some('\n') => {}
            Some(escaped) => value.push(escaped),
        }
    }
}

// Text inside double quotes: a backslash before `$`, `` ` ``, `"` or another backslash keeps that
// character, a backslash and a line break go together, any other backslash stays, and one ending
// the text is dropped.
fn unescape_double_quoted(text: &str, value: &mut String) {
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            value.push(character);
            continue;
        }
        match characters.next() {
            None | Some('\n') => {}
            Some(escaped @ ('$' | '`' | '"' | '\\')) => value.push(escaped),
            Some(escaped) => {
                value.push('\\');
                value.push(escaped);
            }
        }
    }
}

// An ANSI-C quoted string's body, `$'` already taken off, decoded as bash decodes it up to its
// closing quote. A decoded NUL ends the string's value there, as it ends bash's C string; the
// parts of a word after the string still join.
fn decode_ansi_c(body: &str, value: &mut String) {
    let characters: Vec<char> = body.chars().collect();
    let limit = characters.len();
    let mut position = 0;
    while position < limit && characters[position] != '\'' {
        if characters[position] != '\\' || position + 1 >= limit {
            // A run of plain characters; a backslash at the end has nothing to escape.
            while position < limit {
                let character = characters[position];
                if character == '\'' || (character == '\\' && position + 1 < limit) {
                    break;
                }
                value.push(character);
                position += 1;
            }
            continue;
        }
        let escape_start = position;
        let escaped = characters[position + 1];
        position += 2;
        match escaped {
            'a' => value.push('\u{7}'),
            'b' => value.push('\u{8}'),
            'e' | 'E' => value.push('\u{1b}'),
            'f' => value.push('\u{c}'),
            'n' => value.push('\n'),
            'r' => value.push('\r'),
            't' => value.push('\t'),
            'v' => value.push('\u{b}'),
            '\\' | '\'' | '"' | '?' => value.push(escaped),
            '\n' => {}
            'c' => match decode_control(&characters, position, value) {
                Some(next) => position = next,
                None => return,
            },
            'x' | 'u' | 'U' => {
                let most_digits = match escaped {
                    'x' => 2,
                    'u' => 4,
                    _ => 8,
                };
                let digits_start = position;
                let mut code = 0_u32;
                while position < limit && position - digits_start < most_digits {
                    let Some(digit) = characters[position].to_digit(16) else {
                        break;
                    };
                    code = code * 16 + digit;
                    position += 1;
                }
                if position == digits_start {
                    value.push('\\');
                    value.push(escaped);
                } else if code == 0 {
                    return;
                } else if let Some(decoded) = char::from_u32(code) {
                    value.push(decoded);
                } else {
                    // A code no character has stays as it was written.
                    value.extend(&characters[escape_start..position]);
                }
            }
            '0'..='7' => {
                let mut code = escaped.to_digit(8).expect("an octal digit");
                while position < limit && position - escape_start - 1 < 3 {
                    let Some(digit) = characters[position].to_digit(8) else {
                        break;
                    };
                    code = code * 8 + digit;
                    position += 1;
                }
                let byte = u8::try_from(code & 0xFF).expect("a value masked to one byte");
                if byte == 0 {
                    return;
                }
                value.push(char::from(byte));
            }
            _ => {
                value.push('\\');
                value.push(escaped);
            }
        }
    }
}

// `\c` and its operand from `position`: the control character the operand names, `\c` as written
// when the closing quote or the end follows. Returns the position past what it read, or `None`
// when the operand names NUL, which ends the string's value.
fn decode_control(characters: &[char], mut position: usize, value: &mut String) -> Option<usize> {
    let limit = characters.len();
    let Some(&operand) = characters.get(position).filter(|&&operand| operand != '\'') else {
        value.push_str("\\c");
        return Some(position);
    };
    position += 1;
    if operand == '\\' {
        // Bash writes a backslash operand as the pair `\c\\`; a lone backslash still decodes and
        // leaves the character after it as written.
        let is_pair = characters.get(position) == Some(&'\\');
        value.push('\u{1c}');
        if is_pair {
            position += 1;
        } else if position < limit {
            value.push(characters[position]);
            position += 1;
        }
        return Some(position);
    }
    let code = if operand == '?' {
        0x7F
    } else {
        u32::from(operand) & 0x1F
    };
    if code == 0 {
        return None;
    }
    value.push(char::from_u32(code).expect("a code below 0x80 is a character"));
    Some(position)
}
