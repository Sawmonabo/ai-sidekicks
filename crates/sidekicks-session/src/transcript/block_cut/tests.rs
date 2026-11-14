use std::collections::{BTreeMap, HashMap};

use satteri_pulldown_cmark::parse_no_positions;
use sidekicks_contracts::transcript::content::BlockStarts;

use super::{
    BYTE_ORDER_MARK, CUT_WINDOW_BYTES, EndedBodyCut, MARKDOWN_OPTIONS, MARKDOWN_PARSE, ProseBody,
    SETTLE_LAG_BLOCKS, StreamingBlockCut, block_ends_of, body_block_starts, utf16_offsets_of,
};

/// The desktop's hand cases, read where the desktop's own tests read them.
const HAND_CASES: &str =
    include_str!("../../../../../apps/desktop/tests/browser/markdown-cut-cases.json");

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

/// A declared markdown body whose escape sequences, one cut between two pieces and one ended by an
/// astral character, move its stored offsets off the drawn ones.
const ESCAPED_BODY: &str = concat!(
    "First.\u{1b}[1;31m\n\n",
    "\u{1b}]8;;https://a.example\u{7}Second.\u{1b}P1$r\u{9c}\n\n",
    "\u{1b}\u{1f600}Third.\n",
);

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
    body_block_starts(text, is_final, MARKDOWN_PARSE)
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
            let ends = block_ends_of(&text, true, window_bytes, SETTLE_LAG_BLOCKS, MARKDOWN_PARSE)
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
        let seeded = StreamingBlockCut::seeded(ProseBody::Declared, &text, MARKDOWN_PARSE)
            .expect("it advances");
        let mut read_then_streamed = open;
        read_then_streamed.extend(unpacked(seeded.finish().expect("the cut advances")));
        assert_eq!(read_then_streamed, expected_utf16, "seeded {text:?}");
        for seed in 1..=3 {
            let mut cut = StreamingBlockCut::new(ProseBody::Declared, MARKDOWN_PARSE);
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

// Killed by an ended body's cut, handed a stretch at a time, that keeps a start at another stored
// byte or drawn offset than one cut of the whole body, which cuts the body's parts at the wrong
// byte: on a body whose escape sequences move its stored offsets off the drawn ones, a long body
// of many blocks, and one block past two windows, whose tail is parsed again only once a window or
// an eighth of it, whichever is more, arrived.
#[test]
fn an_ended_body_cut_a_stretch_at_a_time_keeps_the_starts_of_one_whole_cut() {
    let code_lines = "a line of code\n".repeat(CUT_WINDOW_BYTES / 4);
    let one_long_block = format!("Intro.\n\n```\n{code_lines}```\n\nAfter.\n\n- one\n- two\n");
    let many_blocks = texts().pop().expect("the long body is the last text");
    for body in [ESCAPED_BODY.to_owned(), many_blocks, one_long_block] {
        let whole = body_block_starts(&body, true, MARKDOWN_PARSE).expect("the cut advances");
        let mut cut = EndedBodyCut::new(ProseBody::Declared, MARKDOWN_PARSE);
        let mut from = 0;
        for end in piece_ends(&body, 1) {
            let pushed = cut.push(&body[from..end]).expect("the cut advances");
            assert!(pushed.is_continue(), "a declared body stays markdown");
            from = end;
        }
        let opening = &body[..body.floor_char_boundary(40)];
        assert_eq!(
            cut.finish().expect("the cut advances"),
            Some(whole),
            "{opening:?}"
        );
    }
}

// Block ends of `text` streamed a character at a time: the text past the ends so far is cut
// again after each append holding back `lag_blocks`, then cut whole once it is all in.
fn streamed_block_ends(text: &str, lag_blocks: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut from = 0;
    for (index, character) in text.char_indices() {
        let received = index + character.len_utf8();
        let tail = block_ends_of(
            &text[from..received],
            false,
            65_536,
            lag_blocks,
            MARKDOWN_PARSE,
        )
        .expect("the cut advances");
        ends.extend(tail.iter().map(|end| from + end));
        from = ends.last().copied().unwrap_or(0);
    }
    let last = block_ends_of(&text[from..], true, 65_536, lag_blocks, MARKDOWN_PARSE)
        .expect("it advances");
    ends.extend(last.iter().map(|end| from + end));
    ends
}

// The negative control: holding back one child freezes a loose ordered list before its third
// item arrives, which two children of lag do not.
#[test]
fn block_cut_with_one_child_of_lag_splits_a_loose_list() {
    let text = "Intro.\n\n1. one\n\n2. two, loose\n\n3. three\n\nAfter.\n";
    let whole = block_ends_of(
        text,
        true,
        text.len() + 1,
        SETTLE_LAG_BLOCKS,
        MARKDOWN_PARSE,
    )
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
// the drawn text, by a sequence cut between two pieces kept in part, and by an astral character
// ending a sequence kept in part, which would leave half a UTF-16 pair in the drawn text.
#[test]
fn block_cut_measures_starts_on_the_text_drawn_without_escape_sequences() {
    let text = ESCAPED_BODY;
    let drawn = "First.\n\nSecond.\n\nThird.\n";
    let starts = body_block_starts(text, true, MARKDOWN_PARSE).expect("the cut advances");
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
    assert!(text[starts[2].stored_offset..].starts_with("Third."));
    let mut cut = StreamingBlockCut::new(ProseBody::Declared, MARKDOWN_PARSE);
    let mut streamed = Vec::new();
    let split = text.find("[1;31m").expect("the text holds the sequence") + 3;
    for piece in [&text[..split], &text[split..]] {
        streamed.extend(unpacked(cut.push(piece).expect("it advances")));
    }
    streamed.extend(unpacked(cut.finish().expect("it advances")));
    assert_eq!(streamed, drawn_offsets);
}
