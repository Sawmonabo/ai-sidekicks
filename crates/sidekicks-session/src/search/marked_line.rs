//! The line a hit shows: the line of a row's text its first match sits in, cut to a bound in code
//! points around that match, with the matched stretches inside it in UTF-16 code units.

use sidekicks_contracts::session::methods::SearchMatchRange;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_search::index::MatchRange;
use sidekicks_std::text_cut::cut_to_code_points;

/// How many code points of the line before the first match a cut line keeps, so the match reads
/// in context.
const LEADING_CONTEXT_LENGTH: usize = 40;

/// One line of a hit's text and the matched stretches in it, in UTF-16 code units from the line's
/// start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MarkedLine {
    /// The line, cut to the bound.
    pub(crate) line: String,
    /// The matched stretches inside the cut line, in order.
    pub(crate) match_ranges: Vec<SearchMatchRange>,
}

/// The line of `text` holding `first`, at most `max_length` code points long, with `first` and
/// `later` cut to it; the ranges count UTF-16 code units, run in order and never overlap.
pub(crate) fn cut_marked_line(
    text: &str,
    first: MatchRange,
    later: &[MatchRange],
    max_length: usize,
) -> MarkedLine {
    let match_start = byte_offset_of_unit(text, first.start as usize);
    let line_start = text[..match_start]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    let mut line_end = text[match_start..]
        .find('\n')
        .map_or(text.len(), |newline| match_start + newline);
    if text[..line_end].ends_with('\r') {
        line_end -= 1;
    }
    let line = &text[line_start..line_end];
    let line_length = line.chars().count();
    let mut cut_start = 0;
    if line_length > max_length {
        let match_offset = text[line_start..match_start].chars().count();
        cut_start = match_offset
            .saturating_sub(LEADING_CONTEXT_LENGTH)
            .min(line_length - max_length);
    }
    let cut_end = line_length.min(cut_start + max_length);
    let cut_start_byte = line_start + cut_to_code_points(line, cut_start).len();
    let cut_end_byte = line_start + cut_to_code_points(line, cut_end).len();
    let cut_start_unit = text[..cut_start_byte].encode_utf16().count();
    let cut_end_unit = cut_start_unit + text[cut_start_byte..cut_end_byte].encode_utf16().count();
    let match_ranges = std::iter::once(&first)
        .chain(later)
        .filter_map(|range| {
            let start = (range.start as usize).max(cut_start_unit);
            let end = (range.end as usize).min(cut_end_unit);
            (end > start).then(|| SearchMatchRange {
                start: SafeInt::new((start - cut_start_unit) as u64)
                    .expect("an offset into one line is far below 2^53"),
                end: SafeInt::new((end - cut_start_unit) as u64)
                    .expect("a range's end lies past its start, so at least 1, and below 2^53"),
            })
        })
        .collect();
    MarkedLine {
        line: text[cut_start_byte..cut_end_byte].to_owned(),
        match_ranges,
    }
}

// The byte offset of the character at UTF-16 offset `unit`, or the text's end past it.
fn byte_offset_of_unit(text: &str, unit: usize) -> usize {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units >= unit {
            return byte;
        }
        units += character.len_utf16();
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_search::index::MatchRange;

    use super::cut_marked_line;

    #[rstest]
    // A short line after a CRLF, an astral character before the match; the range on the next line
    // is dropped.
    #[case(
        "first line\r\n😀 needle 😀 needle\nneedle".to_owned(),
        (15, 21),
        vec![(25, 31), (32, 38)],
        100,
        "😀 needle 😀 needle".to_owned(),
        vec![(3, 9), (13, 19)],
    )]
    // A long line cut 40 code points before the match, dropping 11 astral characters (22 units);
    // the later range is clipped at the cut's end.
    #[case(
        format!("{} needle{}", "😀".repeat(50), "😀".repeat(10)),
        (101, 104),
        vec![(104, 109)],
        46,
        format!("{} needle", "😀".repeat(39)),
        vec![(79, 82), (82, 85)],
    )]
    fn a_hit_line_is_cut_in_code_points_with_ranges_rebased_in_units(
        #[case] text: String,
        #[case] first: (u32, u32),
        #[case] later: Vec<(u32, u32)>,
        #[case] max_length: usize,
        #[case] expected_line: String,
        #[case] expected_ranges: Vec<(u64, u64)>,
    ) {
        let range = |(start, end): (u32, u32)| MatchRange { start, end };
        let later: Vec<MatchRange> = later.into_iter().map(range).collect();
        let marked = cut_marked_line(&text, range(first), &later, max_length);
        assert_eq!(marked.line, expected_line);
        let ranges: Vec<(u64, u64)> = marked
            .match_ranges
            .iter()
            .map(|range| (range.start.get(), range.end.get()))
            .collect();
        assert_eq!(ranges, expected_ranges);
    }
}
