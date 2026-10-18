//! The colorer's theme: which `TextMate` scopes paint as which span class.
//!
//! The engine hands each token the foreground its scopes resolve to under a theme, and keeps only a
//! hex color as a foreground. So each span class takes a sentinel color of its own, and the class
//! falls out of the theme's own scope resolution; a token on the theme's own foreground is plain
//! and carries no span. The colors a person sees stay with the surface that paints the classes.

use ferriki_textmate::{RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle};
use sidekicks_contracts::highlight::HighlightSpanClass;
use strum::VariantArray as _;

/// The foreground of text no class claims, the theme's own.
const PLAIN_FOREGROUND: &str = "#FFFFFE";

/// The theme's background, which no span reads.
const BACKGROUND: &str = "#000000";

/// The sentinel color of the first class in wire order; each later class takes the next.
const FIRST_SENTINEL: usize = 0x10;

/// Scopes a broader class rule would otherwise claim that stay plain: an operator is not a
/// keyword, and punctuation and braces read as the text around them.
const PLAIN_SCOPES: [&str; 3] = ["keyword.operator", "punctuation", "meta.brace"];

/// Which scopes a span class claims. Types and classes read as names. The quotes around a string
/// and the marks that open a comment paint with what they enclose, as do a diff line's sign and the
/// marks around a Markdown heading, emphasis and inline code. A diff's file header lines (`---`,
/// `+++`) read as the removed and added lines they name.
fn scopes_of(class: HighlightSpanClass) -> &'static [&'static str] {
    match class {
        HighlightSpanClass::Keyword => &[
            "keyword",
            "storage",
            "storage.type",
            "storage.modifier",
            "keyword.control",
        ],
        HighlightSpanClass::Name => &[
            "entity.name.function",
            "support.function",
            "variable.function",
            "entity.name.tag",
            "entity.name.type",
            "entity.name.class",
            "support.type",
            "support.class",
        ],
        HighlightSpanClass::String => &[
            "string",
            "string.quoted",
            "punctuation.definition.string",
            "constant.character.escape",
            "meta.embedded.string",
        ],
        HighlightSpanClass::Number => &["constant.numeric", "constant.language", "constant.other"],
        HighlightSpanClass::Comment => &["comment", "punctuation.definition.comment"],
        HighlightSpanClass::Inserted => &[
            "markup.inserted",
            "punctuation.definition.inserted",
            "meta.diff.header.to-file",
            "punctuation.definition.to-file",
        ],
        HighlightSpanClass::Deleted => &[
            "markup.deleted",
            "punctuation.definition.deleted",
            "meta.diff.header.from-file",
            "punctuation.definition.from-file",
        ],
        HighlightSpanClass::Hunk => &["meta.diff.range", "punctuation.definition.range"],
        HighlightSpanClass::Heading => &["markup.heading", "punctuation.definition.heading"],
        HighlightSpanClass::Emphasis => &[
            "markup.bold",
            "markup.italic",
            "punctuation.definition.bold",
            "punctuation.definition.italic",
        ],
        HighlightSpanClass::InlineCode => &["markup.inline.raw", "punctuation.definition.raw"],
    }
}

/// The sentinel color of the class at `wire_index`, two uppercase hex digits as the engine keeps
/// them: `#000010` for the first.
fn sentinel_of(wire_index: usize) -> String {
    format!("#0000{:02X}", FIRST_SENTINEL + wire_index)
}

/// One theme rule painting `scopes` as `foreground`.
fn setting(scopes: &[&str], foreground: String) -> RawThemeSetting {
    RawThemeSetting::default()
        .with_scope(Some(RawThemeScope::Array(
            scopes.iter().map(|scope| (*scope).to_owned()).collect(),
        )))
        .with_settings(Some(
            RawThemeStyle::default().with_foreground(Some(foreground)),
        ))
}

/// The theme a highlighter is built with: the plain foreground first, then the plain scopes, then
/// each span class's scopes painted its sentinel color, in wire order.
pub(crate) fn build_code_theme() -> RawTheme {
    let defaults = RawThemeSetting::default().with_settings(Some(
        RawThemeStyle::default()
            .with_foreground(Some(PLAIN_FOREGROUND.to_owned()))
            .with_background(Some(BACKGROUND.to_owned())),
    ));
    let classes = HighlightSpanClass::VARIANTS
        .iter()
        .enumerate()
        .map(|(wire_index, class)| setting(scopes_of(*class), sentinel_of(wire_index)));
    let settings = [
        defaults,
        setting(&PLAIN_SCOPES, PLAIN_FOREGROUND.to_owned()),
    ]
    .into_iter()
    .chain(classes)
    .collect();
    RawTheme::default()
        .with_name(Some("span-classes".to_owned()))
        .with_settings(settings)
}

/// The wire index of the span class each foreground id of a registry's color map paints, `None`
/// for plain text: read once when a highlighter is built, then indexed per token.
pub(crate) fn span_classes_by_foreground(color_map: &[String]) -> Vec<Option<u32>> {
    color_map
        .iter()
        .map(|color| {
            (0..HighlightSpanClass::VARIANTS.len())
                .find(|wire_index| sentinel_of(*wire_index) == *color)
                .map(|wire_index| u32::try_from(wire_index).expect("eleven classes fit"))
        })
        .collect()
}
