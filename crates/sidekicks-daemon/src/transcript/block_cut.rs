//! Where a reply's markdown body is cut into the blocks the screen draws apart: where the parser's
//! own top-level children start, so every block parses alone as it does inside the whole text. A
//! text is read a window of whole lines at a time, a line ending at a line feed, a carriage return
//! or both; every child but the last two of a window is kept, since text after a window's end can
//! still change what they are, and the next window starts at the first one held back. A block
//! starts at the start of its child's first line. Starts travel as UTF-16 offsets, as the desktop
//! indexes text, packed as little-endian `u32`s.

use satteri_pulldown_cmark::{Options, parse_no_positions, parse_no_positions_into};
use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::transcript::content::{BlockStarts, TranscriptRowContent};

/// Top-level children held back at the end of a text that can still grow, behind which a child is
/// final: a setext underline turns the paragraph above it into a heading, and a later item turns
/// the blank line before it into the inside of a loose list. One child of lag closes the first,
/// two close both.
pub(crate) const SETTLE_LAG_BLOCKS: usize = 2;

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
const ESCAPE: char = '\u{1b}';

/// A cut in which a block would end no later than the one before it, as no text should make it.
#[derive(Debug, thiserror::Error)]
#[error("the markdown block cut did not advance past byte {offset}")]
pub(crate) struct StalledBlockCut {
    /// Where the cut stood.
    offset: usize,
}

/// Whether the body of a row whose payload is `payload` is drawn as markdown: a declared markdown
/// media type, or no declaration and no escape byte, which would make it command output.
fn is_prose_body(payload: &Map<String, Value>, body: &str) -> bool {
    match payload
        .get(CONTENT_TYPE_PAYLOAD_KEY)
        .and_then(Value::as_str)
    {
        Some(declared) => {
            let essence = declared.split(';').next().unwrap_or_default().trim();
            MARKDOWN_MEDIA_TYPES
                .iter()
                .any(|media_type| essence.eq_ignore_ascii_case(media_type))
        }
        None => !body.contains(ESCAPE),
    }
}

/// Whether a row of `event_type` whose payload is `payload` and body `body` carries block starts:
/// an agent's reply drawn as markdown.
pub(crate) fn is_cut_into_blocks(
    event_type: &str,
    payload: &Map<String, Value>,
    body: &str,
) -> bool {
    event_type == SessionEventType::AgentMessageSent.as_str() && is_prose_body(payload, body)
}

/// `content`, the inline body of a row of `event_type` whose payload is `payload`, with its block
/// starts when it is cut into blocks. Fails when the cut does not advance.
pub(crate) fn with_block_starts(
    content: TranscriptRowContent,
    event_type: &str,
    payload: &Map<String, Value>,
) -> Result<TranscriptRowContent, StalledBlockCut> {
    Ok(match content {
        TranscriptRowContent::Available {
            body,
            content_length,
            content_truncated,
            block_starts: _,
        } => {
            let block_starts = if is_cut_into_blocks(event_type, payload, body.as_str()) {
                block_starts_of(body.as_str())?
            } else {
                None
            };
            TranscriptRowContent::Available {
                body,
                content_length,
                content_truncated,
                block_starts,
            }
        }
        other @ (TranscriptRowContent::Unavailable { .. } | TranscriptRowContent::Large { .. }) => {
            other
        }
    })
}

/// The block starts of `body`, a whole markdown text, packed for the wire; `None` for an empty
/// body. Fails when the cut does not advance.
pub(crate) fn block_starts_of(body: &str) -> Result<Option<BlockStarts>, StalledBlockCut> {
    if body.is_empty() {
        return Ok(None);
    }
    let ends = block_ends_of(body, true, CUT_WINDOW_BYTES, SETTLE_LAG_BLOCKS)?;
    let starts: Vec<usize> = std::iter::once(0)
        .chain(ends.into_iter().filter(|&end| end < body.len()))
        .collect();
    Ok(packed(&utf16_offsets_of(body, &starts, 0)))
}

/// Where each block of `source` cut so far ends, in bytes, ascending, the first block starting at
/// the text's start. A text that is `is_final` keeps every child of its last window; any other
/// keeps back its last `lag_blocks`, whose bounds more text may still move. Fails when a block
/// would end no later than the one before it.
pub(crate) fn block_ends_of(
    source: &str,
    is_final: bool,
    window_bytes: usize,
    lag_blocks: usize,
) -> Result<Vec<usize>, StalledBlockCut> {
    let mut block_ends = Vec::new();
    let mut window_bytes = window_bytes;
    let mut from = 0;
    // One parse's arena is handed to the next, which keeps its capacity.
    let mut arena = None;
    while from < source.len() {
        let to = window_end_of(source, from, window_bytes);
        let is_last = to == source.len();
        let window = &source[from..to];
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
                return Err(StalledBlockCut { offset: last_end });
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
pub(crate) fn utf16_offsets_of(text: &str, starts: &[usize], utf16_base: u64) -> Vec<u64> {
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

/// `starts` packed as the wire carries them, each a little-endian `u32`; `None` for none.
pub(crate) fn packed(starts: &[u64]) -> Option<BlockStarts> {
    if starts.is_empty() {
        return None;
    }
    let bytes: Vec<u8> = starts
        .iter()
        .flat_map(|&start| {
            u32::try_from(start)
                .expect("a body's UTF-16 offset fits 32 bits")
                .to_le_bytes()
        })
        .collect();
    Some(BlockStarts::new(bytes.into()).expect("a body's starts fit one page"))
}

/// A row's cut while its pieces stream in: the text after its last frozen start, and that start
/// as a UTF-16 offset into the row's body. Frozen starts never move.
#[derive(Debug, Default)]
pub(crate) struct StreamingBlockCut {
    /// The row's text from its last frozen start on.
    tail: String,
    /// The last frozen start.
    frozen_utf16: u64,
    /// Whether the row's first start went out.
    has_started: bool,
}

impl StreamingBlockCut {
    /// The cut of a row whose text `received` a reader already holds with its starts, so only
    /// starts frozen after it go out. Fails when the cut does not advance.
    pub(crate) fn seeded(received: &str) -> Result<Self, StalledBlockCut> {
        let mut cut = Self::default();
        cut.push(received)?;
        Ok(cut)
    }

    /// Adds a piece's `text` and answers the starts it froze. Fails when the cut does not advance.
    pub(crate) fn push(&mut self, text: &str) -> Result<Option<BlockStarts>, StalledBlockCut> {
        let mut starts = Vec::new();
        if !self.has_started && !text.is_empty() {
            starts.push(0);
            self.has_started = true;
        }
        self.tail.push_str(text);
        let ends = block_ends_of(&self.tail, false, CUT_WINDOW_BYTES, SETTLE_LAG_BLOCKS)?;
        if let Some(&last_end) = ends.last() {
            starts.extend(utf16_offsets_of(&self.tail, &ends, self.frozen_utf16));
            self.frozen_utf16 = *starts.last().expect("a frozen end was just added");
            self.tail.drain(..last_end);
        }
        Ok(packed(&starts))
    }

    /// The starts the row's whole text leaves unsent once it ends. Fails when the cut does not
    /// advance.
    pub(crate) fn finish(&self) -> Result<Option<BlockStarts>, StalledBlockCut> {
        let ends = block_ends_of(&self.tail, true, CUT_WINDOW_BYTES, SETTLE_LAG_BLOCKS)?;
        let inner: Vec<usize> = ends
            .into_iter()
            .filter(|&end| end < self.tail.len())
            .collect();
        Ok(packed(&utf16_offsets_of(
            &self.tail,
            &inner,
            self.frozen_utf16,
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        SETTLE_LAG_BLOCKS, StreamingBlockCut, block_ends_of, block_starts_of, utf16_offsets_of,
    };
    use sidekicks_contracts::transcript::content::BlockStarts;

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

    // Where each root child of one whole parse of `text` starts, by its line, in bytes.
    fn whole_parse_starts(text: &str) -> Vec<usize> {
        let ends = block_ends_of(text, true, text.len() + 1, SETTLE_LAG_BLOCKS)
            .expect("a whole parse advances");
        std::iter::once(0)
            .chain(ends.into_iter().filter(|&end| end < text.len()))
            .filter(|_| !text.is_empty())
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
    // NUL or a byte order mark left in the parser's bytes, by UTF-16 offsets counted in bytes, and
    // by a streamed start sent twice, moved or left out.
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
            assert_eq!(
                unpacked(block_starts_of(&text).expect("the cut advances")),
                expected_utf16
            );
            for seed in 1..=3 {
                let mut cut = StreamingBlockCut::default();
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
}
