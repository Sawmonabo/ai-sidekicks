//! Where a reply's markdown body is cut into the blocks the screen draws apart: where the parser's
//! own top-level children start, so every block parses alone as it does inside the whole text. A
//! text is read a window of whole lines at a time, a line ending at a line feed, a carriage return
//! or both; every child but the last two of a window is kept, since text after a window's end can
//! still change what they are, and the next window starts at the first one held back. A block
//! starts at the start of its child's first line. The text cut is the one the screen draws, its
//! escape sequences left out, and starts travel as UTF-16 offsets into it, as the desktop indexes
//! text, packed as little-endian `u32`s. A row whose reply is still arriving is cut the same way
//! with its last two children held back, so a start once sent never moves. A cut that fails fails
//! its row alone, which then carries why.

use std::borrow::Cow;
use std::error::Error;

use satteri_pulldown_cmark::{Options, parse_no_positions, parse_no_positions_into};
use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::transcript::content::{
    BlockCutFailure, BlockStarts, BodyBlockStart, TranscriptRowContent,
};

use crate::transcript::escape_sequences::{ESCAPE, EscapeSequenceStripper};

/// Top-level children held back at the end of a text that can still grow, behind which a child is
/// final: a setext underline turns the paragraph above it into a heading, and a later item turns
/// the blank line before it into the inside of a loose list. One child of lag closes the first,
/// two close both.
const SETTLE_LAG_BLOCKS: usize = 2;

/// The bytes of text one window parses first, cut back to whole lines; a window holding too few
/// children to keep one is parsed again twice as long.
const CUT_WINDOW_BYTES: usize = 65_536;

/// The parser features the desktop draws markdown with: GitHub's tables, footnotes,
/// strikethrough and task lists, and math, with no front matter.
const MARKDOWN_OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS)
    .union(Options::ENABLE_MATH)
    .union(Options::ENABLE_GFM);

/// The declared media types a body is drawn as markdown under; `text/x-markdown` is an older
/// spelling.
const MARKDOWN_MEDIA_TYPES: [&str; 2] = ["text/markdown", "text/x-markdown"];

/// The payload member naming a body's declared media type.
const CONTENT_TYPE_PAYLOAD_KEY: &str = "contentType";

const BYTE_ORDER_MARK: char = '\u{feff}';

/// A text the cut stalls on in tests, so a test can show that one row's failed cut leaves every
/// other row served.
#[cfg(test)]
pub(crate) const STALLING_TEXT: &str = "THE-BLOCK-CUT-STALLS-HERE";

/// Why a markdown cut failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BlockCutError {
    /// A block would end no later than the one before it, as no text should make it.
    #[error("the markdown block cut did not advance past byte {offset}")]
    Stalled {
        /// Where the cut stood.
        offset: usize,
    },
    /// The starts one piece froze do not fit one page.
    #[error("{count} block starts take more than one page")]
    OverPage {
        /// How many starts there were.
        count: usize,
    },
}

impl BlockCutError {
    /// The failure the row carries in place of its starts.
    pub(crate) fn failure(&self) -> BlockCutFailure {
        match self {
            Self::Stalled { .. } => BlockCutFailure::Stalled,
            Self::OverPage { .. } => BlockCutFailure::OverPage,
        }
    }

    /// Logs the failure the row will carry, so the service's log keeps its cause.
    pub(crate) fn logged(self) -> BlockCutFailure {
        tracing::warn!(
            error = &self as &(dyn Error + 'static),
            "a reply's markdown cut failed; its row goes out without block starts"
        );
        self.failure()
    }
}

/// How a reply body is drawn as markdown: by its declared media type, or with none declared, when
/// it is prose only while it holds no escape byte, which would make it command output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProseBody {
    /// A declared markdown body, whose escape sequences the screen leaves out.
    Declared,
    /// A body with no declared media type.
    Undeclared,
}

impl ProseBody {
    /// Whether `text`, the body or a piece of it, keeps the body drawn as markdown.
    pub(crate) fn admits(self, text: &str) -> bool {
        match self {
            Self::Declared => true,
            Self::Undeclared => !text.contains(ESCAPE),
        }
    }
}

/// How the body of a row of `event_type` whose payload is `payload` may be drawn as markdown: an
/// agent's reply declared markdown or declaring nothing; `None` for every other body.
pub(crate) fn prose_body_of(event_type: &str, payload: &Map<String, Value>) -> Option<ProseBody> {
    if event_type != SessionEventType::AgentMessageSent.as_str() {
        return None;
    }
    match payload
        .get(CONTENT_TYPE_PAYLOAD_KEY)
        .and_then(Value::as_str)
    {
        Some(declared) => {
            let essence = declared.split(';').next().unwrap_or_default().trim();
            MARKDOWN_MEDIA_TYPES
                .iter()
                .any(|media_type| essence.eq_ignore_ascii_case(media_type))
                .then_some(ProseBody::Declared)
        }
        None => Some(ProseBody::Undeclared),
    }
}

/// `content`, the inline body of a row whose body may be drawn as `prose`, with its block starts
/// when it is cut into blocks: every start once its reply `is_final`, else those no later text can
/// move. A cut that fails leaves the row its failure in place of starts.
pub(crate) fn with_block_starts(
    content: TranscriptRowContent,
    prose: Option<ProseBody>,
    is_final: bool,
) -> TranscriptRowContent {
    match content {
        TranscriptRowContent::Available {
            body,
            content_length,
            content_truncated,
            block_starts: _,
            block_cut_failure: _,
        } => {
            let cut = prose.filter(|prose| prose.admits(body.as_str())).map(|_| {
                body_block_starts(body.as_str(), is_final)
                    .and_then(|starts| packed(starts.iter().map(|start| start.drawn_offset)))
            });
            let (block_starts, block_cut_failure) = match cut {
                None => (None, None),
                Some(Ok(block_starts)) => (block_starts, None),
                Some(Err(error)) => (None, Some(error.logged())),
            };
            TranscriptRowContent::Available {
                body,
                content_length,
                content_truncated,
                block_starts,
                block_cut_failure,
            }
        }
        other @ (TranscriptRowContent::Unavailable { .. } | TranscriptRowContent::Large { .. }) => {
            other
        }
    }
}

/// The block starts of `body`, a prose body, each in the stored body and in the drawn text: every
/// start once its reply `is_final`, else those no later text can move. Fails when the cut does not
/// advance.
pub(crate) fn body_block_starts(
    body: &str,
    is_final: bool,
) -> Result<Vec<BodyBlockStart>, BlockCutError> {
    let drawn = DrawnText::of(body);
    if drawn.text.is_empty() {
        return Ok(Vec::new());
    }
    let ends = block_ends_of(&drawn.text, is_final, CUT_WINDOW_BYTES, SETTLE_LAG_BLOCKS)?;
    let starts: Vec<usize> = std::iter::once(0)
        .chain(ends.into_iter().filter(|&end| end < drawn.text.len()))
        .collect();
    let drawn_offsets = utf16_offsets_of(&drawn.text, &starts, 0);
    Ok(starts
        .iter()
        .zip(drawn_offsets)
        .map(|(&start, drawn_offset)| BodyBlockStart {
            stored_offset: drawn.stored_offset_of(start),
            drawn_offset: u32::try_from(drawn_offset).expect("a body's UTF-16 offset fits 32 bits"),
        })
        .collect())
}

/// A body as the screen draws it, its escape sequences left out, with where each kept run sits in
/// the stored body.
struct DrawnText<'body> {
    text: Cow<'body, str>,
    /// Each kept run's start in the drawn text and in the stored body; empty when nothing was left
    /// out.
    runs: Vec<(usize, usize)>,
}

impl<'body> DrawnText<'body> {
    fn of(body: &'body str) -> Self {
        if !body.contains(ESCAPE) {
            return Self {
                text: Cow::Borrowed(body),
                runs: Vec::new(),
            };
        }
        let mut text = String::with_capacity(body.len());
        let mut runs = Vec::new();
        for (stored_start, run) in EscapeSequenceStripper::default().kept_runs(body) {
            runs.push((text.len(), stored_start));
            text.push_str(run);
        }
        Self {
            text: Cow::Owned(text),
            runs,
        }
    }

    /// Where the character at `drawn`, a byte offset into the drawn text, sits in the stored body.
    fn stored_offset_of(&self, drawn: usize) -> usize {
        let run = self
            .runs
            .partition_point(|&(drawn_start, _)| drawn_start <= drawn)
            .checked_sub(1)
            .and_then(|index| self.runs.get(index));
        run.map_or(drawn, |&(drawn_start, stored_start)| {
            stored_start + drawn - drawn_start
        })
    }
}

/// Where each block of `source` cut so far ends, in bytes, ascending, the first block starting at
/// the text's start. A text that is `is_final` keeps every child of its last window; any other
/// keeps back its last `lag_blocks`, whose bounds more text may still move. Fails when a block
/// would end no later than the one before it.
fn block_ends_of(
    source: &str,
    is_final: bool,
    window_bytes: usize,
    lag_blocks: usize,
) -> Result<Vec<usize>, BlockCutError> {
    let mut block_ends = Vec::new();
    let mut window_bytes = window_bytes;
    let mut from = 0;
    // One parse's arena is handed to the next, which keeps its capacity.
    let mut arena = None;
    while from < source.len() {
        let to = window_end_of(source, from, window_bytes);
        let is_last = to == source.len();
        let window = &source[from..to];
        #[cfg(test)]
        if window.contains(STALLING_TEXT) {
            return Err(BlockCutError::Stalled { offset: from });
        }
        let parsed = ParsedWindow::of(window);
        let (tree, _) = match arena.take() {
            Some(reuse) => parse_no_positions_into(parsed.text(window), MARKDOWN_OPTIONS, reuse),
            None => parse_no_positions(parsed.text(window), MARKDOWN_OPTIONS),
        };
        // The root is the parse's first node.
        let child_starts: Vec<usize> = tree
            .get_children(0)
            .iter()
            .map(|&child| {
                let start = usize::try_from(tree.get_node(child).start_offset)
                    .expect("an offset fits memory");
                parsed.window_offset_of(start)
            })
            .collect();
        arena = Some(tree);
        let kept_count = if is_last && is_final {
            child_starts.len()
        } else {
            child_starts.len().saturating_sub(lag_blocks)
        };
        if kept_count == 0 {
            if is_last {
                break;
            }
            window_bytes *= 2;
            continue;
        }
        let mut last_end = from;
        for index in 1..=kept_count {
            let end = match child_starts.get(index) {
                Some(&start) => from + line_start_of(window, start, 0),
                None => source.len(),
            };
            if end <= last_end {
                return Err(BlockCutError::Stalled { offset: last_end });
            }
            block_ends.push(end);
            last_end = end;
        }
        from = last_end;
        if is_last {
            break;
        }
    }
    Ok(block_ends)
}

/// Where the window from `from` ends: after the last whole line within `window_bytes`, a carriage
/// return's line feed with it; a line longer than the window is cut inside it, at a character.
fn window_end_of(source: &str, from: usize, window_bytes: usize) -> usize {
    let to = source.floor_char_boundary(from.saturating_add(window_bytes).min(source.len()));
    if to == source.len() {
        return to;
    }
    let last_line_start = line_start_of(source, to, from);
    if last_line_start == from {
        return to.max(source.ceil_char_boundary(from + 1));
    }
    let bytes = source.as_bytes();
    if bytes[last_line_start - 1] == b'\r' && bytes.get(last_line_start) == Some(&b'\n') {
        last_line_start + 1
    } else {
        last_line_start
    }
}

/// Where the line holding `offset` starts in `text`, looking back no further than `floor`.
fn line_start_of(text: &str, offset: usize, floor: usize) -> usize {
    text.as_bytes()[floor..offset]
        .iter()
        .rposition(|&byte| byte == b'\n' || byte == b'\r')
        .map_or(floor, |index| floor + index + 1)
}

/// A window as the parser reads it, parsed as the desktop parses a text: each NUL replaced by
/// U+FFFD, and a byte order mark the window opens on read as text, by a line feed put ahead of it.
struct ParsedWindow {
    /// The text the parser reads, when it differs from the window.
    rewritten: Option<String>,
    /// The bytes put ahead of the window.
    lead_length: usize,
    /// Where each NUL of the window sits.
    nul_offsets: Vec<usize>,
}

impl ParsedWindow {
    fn of(window: &str) -> Self {
        let lead = if window.starts_with(BYTE_ORDER_MARK) {
            "\n"
        } else {
            ""
        };
        let nul_offsets: Vec<usize> = window.match_indices('\0').map(|(index, _)| index).collect();
        let rewritten = (!lead.is_empty() || !nul_offsets.is_empty())
            .then(|| format!("{lead}{}", window.replace('\0', "\u{fffd}")));
        Self {
            rewritten,
            lead_length: lead.len(),
            nul_offsets,
        }
    }

    fn text<'text>(&'text self, window: &'text str) -> &'text str {
        self.rewritten.as_deref().unwrap_or(window)
    }

    /// The window's offset of `parsed`, an offset in the parsed text, where each NUL is widened to
    /// the three bytes of U+FFFD.
    fn window_offset_of(&self, parsed: usize) -> usize {
        let parsed = parsed - self.lead_length;
        let widened_before = self
            .nul_offsets
            .iter()
            .enumerate()
            .take_while(|(index, offset)| **offset + 2 * index < parsed)
            .count();
        parsed - 2 * widened_before
    }
}

/// `starts`, byte offsets of `text` ascending, as UTF-16 offsets counted from `utf16_base`, read
/// in one pass.
fn utf16_offsets_of(text: &str, starts: &[usize], utf16_base: u64) -> Vec<u64> {
    let mut offsets = Vec::with_capacity(starts.len());
    let mut units = utf16_base;
    let mut next = starts.iter().peekable();
    for (index, character) in text.char_indices() {
        while next.next_if(|&&start| start <= index).is_some() {
            offsets.push(units);
        }
        units += u64::try_from(character.len_utf16()).expect("a character is one or two units");
    }
    offsets.extend(next.map(|_| units));
    offsets
}

/// `starts`, UTF-16 offsets, packed as the wire carries them, each a little-endian `u32`; `None`
/// for none. Fails when they take more than one page.
fn packed(starts: impl Iterator<Item = u32>) -> Result<Option<BlockStarts>, BlockCutError> {
    let bytes: Vec<u8> = starts.flat_map(u32::to_le_bytes).collect();
    if bytes.is_empty() {
        return Ok(None);
    }
    let count = bytes.len() / 4;
    BlockStarts::new(bytes.into())
        .map(Some)
        .ok_or(BlockCutError::OverPage { count })
}

/// UTF-16 offsets as the wire's `u32`s.
fn wire_offsets(starts: Vec<u64>) -> impl Iterator<Item = u32> {
    starts
        .into_iter()
        .map(|start| u32::try_from(start).expect("a body's UTF-16 offset fits 32 bits"))
}

/// A row's cut while its pieces stream in: the drawn text after its last frozen start, and that
/// start as a UTF-16 offset into the row's drawn body. Frozen starts never move.
#[derive(Debug)]
pub(crate) struct StreamingBlockCut {
    /// How the row's body is drawn as markdown.
    prose: ProseBody,
    /// Where the row's text stands among escape sequences, so one cut between pieces is removed
    /// whole.
    stripper: EscapeSequenceStripper,
    /// The row's drawn text from its last frozen start on.
    tail: String,
    /// The last frozen start.
    frozen_utf16: u64,
    /// Whether the row's first start went out.
    has_started: bool,
}

impl StreamingBlockCut {
    /// The cut of a row drawn as `prose` that has received nothing yet.
    pub(crate) fn new(prose: ProseBody) -> Self {
        Self {
            prose,
            stripper: EscapeSequenceStripper::default(),
            tail: String::new(),
            frozen_utf16: 0,
            has_started: false,
        }
    }

    /// The cut of a row drawn as `prose` whose text `received` a reader already holds with its
    /// starts, as a read of the row still arriving gave them, so only starts frozen after them go
    /// out and the ones it froze are never packed. Fails when the cut does not advance.
    pub(crate) fn seeded(prose: ProseBody, received: &str) -> Result<Self, BlockCutError> {
        let mut cut = Self::new(prose);
        cut.advance(received)?;
        Ok(cut)
    }

    /// How the row's body is drawn as markdown.
    pub(crate) fn prose(&self) -> ProseBody {
        self.prose
    }

    /// Adds a piece's `text` and answers the starts it froze. Fails when the cut does not advance
    /// or the starts take more than one page.
    pub(crate) fn push(&mut self, text: &str) -> Result<Option<BlockStarts>, BlockCutError> {
        let starts = self.advance(text)?;
        packed(wire_offsets(starts))
    }

    /// Adds `text` and answers the UTF-16 starts it froze.
    fn advance(&mut self, text: &str) -> Result<Vec<u64>, BlockCutError> {
        let mut starts = Vec::new();
        let mut drawn = String::with_capacity(text.len());
        for (_, run) in self.stripper.kept_runs(text) {
            drawn.push_str(run);
        }
        if !self.has_started && !drawn.is_empty() {
            starts.push(0);
            self.has_started = true;
        }
        self.tail.push_str(&drawn);
        let ends = block_ends_of(&self.tail, false, CUT_WINDOW_BYTES, SETTLE_LAG_BLOCKS)?;
        if let Some(&last_end) = ends.last() {
            starts.extend(utf16_offsets_of(&self.tail, &ends, self.frozen_utf16));
            self.frozen_utf16 = *starts.last().expect("a frozen end was just added");
            self.tail.drain(..last_end);
        }
        Ok(starts)
    }

    /// The starts the row's whole text leaves unsent once it ends. Fails when the cut does not
    /// advance or the starts take more than one page.
    pub(crate) fn finish(&self) -> Result<Option<BlockStarts>, BlockCutError> {
        let ends = block_ends_of(&self.tail, true, CUT_WINDOW_BYTES, SETTLE_LAG_BLOCKS)?;
        let inner: Vec<usize> = ends
            .into_iter()
            .filter(|&end| end < self.tail.len())
            .collect();
        packed(wire_offsets(utf16_offsets_of(
            &self.tail,
            &inner,
            self.frozen_utf16,
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use satteri_pulldown_cmark::parse_no_positions;
    use sidekicks_contracts::transcript::content::BlockStarts;

    use super::{
        BYTE_ORDER_MARK, MARKDOWN_OPTIONS, ProseBody, SETTLE_LAG_BLOCKS, StreamingBlockCut,
        block_ends_of, body_block_starts, utf16_offsets_of,
    };

    /// The desktop's hand cases, read where the desktop's own tests read them.
    const HAND_CASES: &str =
        include_str!("../../../../apps/desktop/tests/browser/markdown-cut-cases.json");

    /// Texts whose lines, marks or characters move offsets: a byte order mark, lone and paired
    /// carriage returns, NUL, dollars and astral characters.
    const EDGE_CASES: [&str; 12] = [
        "\u{feff}# Title\n\nPara.\n",
        "\u{feff}Para one.\n\n\u{feff}Para two.\n",
        "Line one\rLine two\r\r# Heading\r\rAfter.\r",
        "Para.\r\n\r\n- item\r\n- item\r\n\r\nAfter.\r\n",
        "Mixed\r\nends\n\rhere\r\n\n# H\n",
        "Before\0after.\n\n\0# Not a heading\n\nEnd.\n",
        "\0\0\0\n\n- \0item\n\n\0\n",
        "$$\nx = 1\n\ny = 2\n$$\n\nAfter.\n",
        "It costs $5 and $6.\n\n$x$ then $$y$$.\n\nEnd $.\n",
        "\u{1f600} para.\n\n- \u{1f600} item\n\n  \u{1f600} more\n\nAfter \u{1f600}.\n",
        "\u{1f600}\u{1f600}\n===\n\n> \u{1f600}\n> quote\n",
        "- item\n\nAfter.\n\n    code one\n\n    code two\n",
    ];

    // Every text a case checks: the hand cases, the edge cases and one long body built from both.
    fn texts() -> Vec<String> {
        let hand: BTreeMap<String, String> =
            serde_json::from_str(HAND_CASES).expect("the hand cases read as names to texts");
        let mut texts: Vec<String> = hand.into_values().collect();
        texts.extend(EDGE_CASES.iter().map(|text| (*text).to_owned()));
        let long: String = texts
            .iter()
            .cycle()
            .take(4_000)
            .map(String::as_str)
            .collect();
        texts.push(long);
        texts
    }

    // Where each block of `text` starts, in bytes, read straight off one parse of the whole text as
    // the desktop parses it: NUL as U+FFFD and a leading byte order mark behind a line feed. The
    // first block starts at the text's start, every later one at its root child's line start.
    fn whole_parse_starts(text: &str) -> Vec<usize> {
        if text.is_empty() {
            return Vec::new();
        }
        let lead = if text.starts_with(BYTE_ORDER_MARK) {
            "\n"
        } else {
            ""
        };
        let parsed = format!("{lead}{}", text.replace('\0', "\u{fffd}"));
        // The parsed text's offset of each of `text`'s characters.
        let mut text_offset_at = HashMap::new();
        let mut parsed_offset = lead.len();
        for (text_offset, character) in text.char_indices() {
            text_offset_at.insert(parsed_offset, text_offset);
            parsed_offset += if character == '\0' {
                '\u{fffd}'.len_utf8()
            } else {
                character.len_utf8()
            };
        }
        let (tree, _) = parse_no_positions(&parsed, MARKDOWN_OPTIONS);
        let children = tree.get_children(0);
        std::iter::once(0)
            .chain(children.iter().skip(1).map(|&child| {
                let start = usize::try_from(tree.get_node(child).start_offset).expect("fits");
                let at = text_offset_at[&start];
                text[..at].rfind(['\n', '\r']).map_or(0, |index| index + 1)
            }))
            .collect()
    }

    fn unpacked(starts: Option<BlockStarts>) -> Vec<u64> {
        starts.map_or_else(Vec::new, |starts| {
            starts
                .as_bytes()
                .as_chunks::<4>()
                .0
                .iter()
                .map(|&start| u64::from(u32::from_le_bytes(start)))
                .collect()
        })
    }

    // The drawn UTF-16 offsets of a whole cut of `text`.
    fn drawn_starts(text: &str, is_final: bool) -> Vec<u64> {
        body_block_starts(text, is_final)
            .expect("the cut advances")
            .iter()
            .map(|start| u64::from(start.drawn_offset))
            .collect()
    }

    // Cut points a reply streams in at: a small generator, so the same pieces come every run.
    fn piece_ends(text: &str, seed: u64) -> Vec<usize> {
        let mut state = seed;
        let mut ends = Vec::new();
        let mut at = 0;
        while at < text.len() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let step = 1 + usize::try_from(state >> 33).expect("fits") % 600;
            at = text.ceil_char_boundary((at + step).min(text.len()));
            ends.push(at);
        }
        ends
    }

    // Killed by a window's last children kept, by a start off its child's line, by offsets past a
    // NUL or a byte order mark left in the parser's bytes, by UTF-16 offsets counted in bytes, by a
    // streamed start sent twice, moved or left out, by a still-arriving row cut whole, whose last
    // starts could still move, and by a seed that froze other starts than a read of the same text.
    #[test]
    fn block_cut_starts_equal_one_whole_parse_in_any_window_and_streamed() {
        for text in texts() {
            let expected = whole_parse_starts(&text);
            for window_bytes in [16, 64, 256, 1_024, 4_096, 65_536, 262_144] {
                let ends = block_ends_of(&text, true, window_bytes, SETTLE_LAG_BLOCKS)
                    .expect("the cut advances");
                let starts: Vec<usize> = std::iter::once(0)
                    .chain(ends.into_iter().filter(|&end| end < text.len()))
                    .filter(|_| !text.is_empty())
                    .collect();
                assert_eq!(starts, expected, "{window_bytes}-byte windows of {text:?}");
            }
            let expected_utf16 = utf16_offsets_of(&text, &expected, 0);
            assert_eq!(drawn_starts(&text, true), expected_utf16);
            let open = drawn_starts(&text, false);
            assert!(
                expected_utf16.starts_with(&open)
                    && expected_utf16.len() - open.len() <= SETTLE_LAG_BLOCKS,
                "a still-arriving cut of {text:?} sends a prefix holding back at most two blocks"
            );
            let seeded =
                StreamingBlockCut::seeded(ProseBody::Declared, &text).expect("it advances");
            let mut read_then_streamed = open;
            read_then_streamed.extend(unpacked(seeded.finish().expect("the cut advances")));
            assert_eq!(read_then_streamed, expected_utf16, "seeded {text:?}");
            for seed in 1..=3 {
                let mut cut = StreamingBlockCut::new(ProseBody::Declared);
                let mut streamed = Vec::new();
                let mut from = 0;
                for end in piece_ends(&text, seed) {
                    streamed.extend(unpacked(cut.push(&text[from..end]).expect("it advances")));
                    from = end;
                }
                streamed.extend(unpacked(cut.finish().expect("the cut advances")));
                assert_eq!(streamed, expected_utf16, "streamed {text:?}");
            }
        }
    }

    // Block ends of `text` streamed a character at a time: the text past the ends so far is cut
    // again after each append holding back `lag_blocks`, then cut whole once it is all in.
    fn streamed_block_ends(text: &str, lag_blocks: usize) -> Vec<usize> {
        let mut ends = Vec::new();
        let mut from = 0;
        for (index, character) in text.char_indices() {
            let received = index + character.len_utf8();
            let tail = block_ends_of(&text[from..received], false, 65_536, lag_blocks)
                .expect("the cut advances");
            ends.extend(tail.iter().map(|end| from + end));
            from = ends.last().copied().unwrap_or(0);
        }
        let last = block_ends_of(&text[from..], true, 65_536, lag_blocks).expect("it advances");
        ends.extend(last.iter().map(|end| from + end));
        ends
    }

    // The negative control: holding back one child freezes a loose ordered list before its third
    // item arrives, which two children of lag do not.
    #[test]
    fn block_cut_with_one_child_of_lag_splits_a_loose_list() {
        let text = "Intro.\n\n1. one\n\n2. two, loose\n\n3. three\n\nAfter.\n";
        let whole = block_ends_of(text, true, text.len() + 1, SETTLE_LAG_BLOCKS)
            .expect("a whole parse advances");
        assert_eq!(streamed_block_ends(text, SETTLE_LAG_BLOCKS), whole);
        assert_ne!(streamed_block_ends(text, 1), whole);
    }

    // Killed by a parser that splits an indented code block at its blank line once a list closed.
    #[test]
    fn block_cut_keeps_an_indented_code_block_after_a_closed_list_whole() {
        let text = EDGE_CASES[11];
        assert_eq!(
            whole_parse_starts(text),
            [0, "- item\n\n".len(), "- item\n\nAfter.\n\n".len()]
        );
    }

    // Killed by a declared markdown body cut on its raw text, by a start's stored offset taken from
    // the drawn text, and by a sequence cut between two pieces kept in part.
    #[test]
    fn block_cut_measures_starts_on_the_text_drawn_without_escape_sequences() {
        let text = concat!(
            "First.\u{1b}[1;31m\n\n",
            "\u{1b}]8;;https://a.example\u{7}Second.\u{1b}P1$r\u{9c}\n\n",
            "Third.\n",
        );
        let drawn = "First.\n\nSecond.\n\nThird.\n";
        let starts = body_block_starts(text, true).expect("the cut advances");
        let drawn_offsets: Vec<u64> = starts
            .iter()
            .map(|start| u64::from(start.drawn_offset))
            .collect();
        assert_eq!(drawn_offsets, [0, 8, 17]);
        assert_eq!(
            drawn_offsets,
            utf16_offsets_of(drawn, &whole_parse_starts(drawn), 0)
        );
        assert!(text[starts[1].stored_offset..].starts_with("Second."));
        let mut cut = StreamingBlockCut::new(ProseBody::Declared);
        let mut streamed = Vec::new();
        let split = text.find("[1;31m").expect("the text holds the sequence") + 3;
        for piece in [&text[..split], &text[split..]] {
            streamed.extend(unpacked(cut.push(piece).expect("it advances")));
        }
        streamed.extend(unpacked(cut.finish().expect("it advances")));
        assert_eq!(streamed, drawn_offsets);
    }
}
