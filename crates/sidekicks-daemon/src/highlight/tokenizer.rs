//! The colorer's engine: shiki's own `TextMate` grammars, every one registered when a tokenizer
//! is built and each compiled on its first use, run line by line with the grammar state carried
//! from line to line. A source's spans are packed as `[offset, length, class]` triples in UTF-16
//! code units, adjacent spans of one class merged and plain text left out. A span never crosses a
//! line break, so the spans before a line boundary are settled once the line before it is
//! colored, and a later source that begins with the same text resumes there. Each settled
//! boundary keeps the SHA-256 of the text before it, hashed line by line as the lines are colored,
//! so a resumed source is checked against the text its spans came from without hashing that text
//! again.
//!
//! The line rules are shiki's: a line ends at `\n` or `\r\n`, its break left plain; an empty line
//! is skipped; a line of `MAX_LINE_LENGTH` UTF-16 units or more stays plain. A line the engine
//! cannot finish within `LINE_TIME_LIMIT` stays plain too, so a slow line holds no thread. Each
//! plain line keeps the grammar state of the line before it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ferriki_textmate::{
    EncodedTokenAttributes, Grammar, GrammarConfiguration, RawGrammar, RegexError, StateStack,
    SyncRegistry, ThemeError,
};
use ferroni::regexec::onig_set_time_limit;
use memchr::memchr;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::highlight::{HIGHLIGHT_SPAN_WIDTH, HighlightLanguage};
use strum::VariantArray as _;

use crate::highlight::code_theme::{build_code_theme, span_classes_by_foreground};

/// Lines this long or longer, in UTF-16 units, stay plain rather than tokenized, as shiki leaves
/// them; a minified line is the case it exists for.
const MAX_LINE_LENGTH: usize = 20_000;

/// How long one line may take before it stays plain, in milliseconds. The slowest legitimate line
/// measured, 19,999 dense characters of Go, took 300 ms, so ten times that stays clear of a busy
/// machine.
const LINE_TIME_LIMIT_MILLIS: u64 = 3_000;

/// How long one line may take before it stays plain.
const LINE_TIME_LIMIT: Duration = Duration::from_millis(LINE_TIME_LIMIT_MILLIS);

/// The scope names of the grammars that build a scope name from the text they match, themselves or
/// through a grammar they include, as the daemon's JavaScript build worked them out.
const SCOPES_NAMED_FROM_TEXT: &str =
    include_str!("../../js/dist/grammars/scopes-named-from-text.json");

/// One grammar file of the daemon's JavaScript build, by the grammar's name.
macro_rules! grammar_file {
    ($name:literal) => {
        include_str!(concat!("../../js/dist/grammars/", $name, ".json"))
    };
}

/// The grammar shiki colors `language` with. Together the 15 files are every grammar the
/// languages' own grammars include, so each language colors as shiki colors it.
fn grammar_file(language: HighlightLanguage) -> &'static str {
    match language {
        HighlightLanguage::Bash => grammar_file!("shellscript"),
        HighlightLanguage::Css => grammar_file!("css"),
        HighlightLanguage::Diff => grammar_file!("diff"),
        HighlightLanguage::Go => grammar_file!("go"),
        HighlightLanguage::Html => grammar_file!("html"),
        HighlightLanguage::Javascript => grammar_file!("javascript"),
        HighlightLanguage::Json => grammar_file!("json"),
        HighlightLanguage::Jsx => grammar_file!("jsx"),
        HighlightLanguage::Markdown => grammar_file!("markdown"),
        HighlightLanguage::Python => grammar_file!("python"),
        HighlightLanguage::Rust => grammar_file!("rust"),
        HighlightLanguage::Sql => grammar_file!("sql"),
        HighlightLanguage::Tsx => grammar_file!("tsx"),
        HighlightLanguage::Typescript => grammar_file!("typescript"),
        HighlightLanguage::Yaml => grammar_file!("yaml"),
    }
}

/// How each grammar compiles: the regex prefilter off, which keeps a compiled grammar's memory
/// within the colorer's budget, and the rest as shiki configures it.
fn grammar_configuration() -> GrammarConfiguration {
    GrammarConfiguration::default()
        .with_regex_prefilter(false)
        .with_initial_language_id(1)
        .with_balanced_bracket_selectors(Some(vec!["*".to_owned()]))
}

/// One language's registered grammar.
struct LanguageGrammar {
    /// The scope name the registry knows the grammar by.
    scope_name: String,
    /// Whether the grammar builds scope names from the text it matches, itself or through a
    /// grammar it includes; the engine keeps each such name for the tokenizer's life.
    names_scopes_from_text: bool,
}

/// Where a tokenized source's last complete line ends: the grammar state after it, the spans
/// before it and the hash of the text before it, from which a later source beginning with the
/// same text resumes.
#[derive(Clone)]
pub(crate) struct SettledLines {
    /// The grammar state after the last complete line; `None` before any line was tokenized.
    pub(crate) state: Option<Arc<StateStack>>,
    /// Where the line boundary sits, in bytes.
    pub(crate) byte_length: usize,
    /// Where the line boundary sits, in UTF-16 units.
    pub(crate) utf16_length: u32,
    /// How many numbers of the packed spans lie before the boundary.
    pub(crate) span_count: usize,
    /// SHA-256 of the text before the boundary, still open to the lines after it.
    pub(crate) hasher: Sha256,
}

impl SettledLines {
    /// The boundary before the first line.
    pub(crate) fn start() -> Self {
        Self {
            state: None,
            byte_length: 0,
            utf16_length: 0,
            span_count: 0,
            hasher: Sha256::new(),
        }
    }

    /// The SHA-256 of the text before the boundary.
    pub(crate) fn digest(&self) -> [u8; 32] {
        self.hasher.clone().finalize().into()
    }
}

/// A tokenized source, or the part of it a stopped tokenization went through.
pub(crate) struct Tokenized {
    /// Every span colored, packed.
    pub(crate) spans: Arc<[u32]>,
    /// Where its last complete line ends; the spans before it are `spans[..settled.span_count]`.
    pub(crate) settled: SettledLines,
    /// The source bytes this tokenization went through, a resumed prefix not counted.
    pub(crate) colored_bytes: usize,
}

/// How a tokenization ended.
pub(crate) enum TokenizeEnd {
    /// Every line was gone through.
    Finished(Tokenized),
    /// The source was no longer wanted, so it stopped before the next line with the lines it had
    /// gone through.
    Unwanted(Tokenized),
}

/// shiki's 15 grammars and the colorer's theme in one registry. The registry is `!Send`, so a
/// tokenizer is built, used and dropped on the one thread that colors.
pub(crate) struct Tokenizer {
    registry: SyncRegistry,
    grammars: HashMap<HighlightLanguage, LanguageGrammar>,
    /// The span class of each foreground id, by wire index; `None` for plain text.
    span_classes: Vec<Option<u32>>,
    line_time_limit: Duration,
    /// Run before each line inside its time limit, so a test can hold a line past it.
    #[cfg(test)]
    before_line: Option<LineHook>,
}

/// A test's hook on each line the tokenizer colors, handed the line's text.
#[cfg(test)]
pub(crate) type LineHook = Arc<dyn Fn(&str) + Send + Sync>;

impl Tokenizer {
    /// Registers every grammar and the theme, and bounds every regex search the engine runs by
    /// the line time limit, process-wide. Fails only when the bundled grammars or theme do not
    /// load, a fault in the daemon's build.
    pub(crate) fn build() -> Result<Self, TokenizerBuildError> {
        onig_set_time_limit(LINE_TIME_LIMIT_MILLIS);
        let mut registry = SyncRegistry::new(Some(build_code_theme()), None)
            .map_err(TokenizerBuildError::Theme)?;
        let scopes_named_from_text: Vec<String> =
            serde_json::from_str(SCOPES_NAMED_FROM_TEXT).map_err(TokenizerBuildError::ScopeList)?;
        let mut grammars = HashMap::with_capacity(HighlightLanguage::VARIANTS.len());
        for language in HighlightLanguage::VARIANTS {
            let grammar: RawGrammar =
                serde_json::from_str(grammar_file(*language)).map_err(|source| {
                    TokenizerBuildError::Grammar {
                        language: *language,
                        source,
                    }
                })?;
            grammars.insert(
                *language,
                LanguageGrammar {
                    names_scopes_from_text: scopes_named_from_text.contains(&grammar.scope_name),
                    scope_name: grammar.scope_name.clone(),
                },
            );
            registry.add_grammar(grammar, Vec::new());
        }
        let span_classes = span_classes_by_foreground(&registry.get_color_map());
        Ok(Self {
            registry,
            grammars,
            span_classes,
            line_time_limit: LINE_TIME_LIMIT,
            #[cfg(test)]
            before_line: None,
        })
    }

    /// Whether `language`'s grammar builds scope names from the text it matches, which the engine
    /// keeps for the tokenizer's life.
    pub(crate) fn names_scopes_from_text(&self, language: HighlightLanguage) -> bool {
        language_grammar(&self.grammars, language).names_scopes_from_text
    }

    /// Runs `before_line` before each line, inside the line's time limit.
    #[cfg(test)]
    pub(crate) fn set_before_line(&mut self, before_line: Arc<dyn Fn(&str) + Send + Sync>) {
        self.before_line = Some(before_line);
    }

    /// Tokenizes the source `wanted_source` gives as `language`, from the first line or from
    /// `resume`: where an earlier source beginning with the same text settled, with the spans
    /// before it. The source is read through `wanted_source` before each line, and the
    /// tokenization stops `Unwanted` at the first line it gives none. Fails when the grammar or
    /// one of its patterns does not compile.
    pub(crate) fn tokenize(
        &mut self,
        wanted_source: impl Fn() -> Option<Arc<String>>,
        language: HighlightLanguage,
        resume: Option<(&SettledLines, &[u32])>,
    ) -> Result<TokenizeEnd, TokenizeError> {
        let grammar = self
            .registry
            .grammar_for_scope_name(
                &language_grammar(&self.grammars, language).scope_name,
                grammar_configuration(),
            )
            .map_err(|source| TokenizeError::Compile { language, source })?
            .expect("every language's grammar is registered when the tokenizer is built");
        let (mut settled, mut spans) = match resume {
            Some((settled, spans)) => (settled.clone(), spans.to_vec()),
            None => (SettledLines::start(), Vec::new()),
        };
        let mut state = settled.state.clone();
        let mut hasher = settled.hasher.clone();
        let mut byte_offset = settled.byte_length;
        let mut utf16_offset = settled.utf16_length;
        let mut colored_bytes = 0;
        loop {
            let Some(source) = wanted_source() else {
                return Ok(TokenizeEnd::Unwanted(Tokenized {
                    spans: Arc::from(spans),
                    settled,
                    colored_bytes,
                }));
            };
            let Some(rest) = source.get(byte_offset..).filter(|rest| !rest.is_empty()) else {
                break;
            };
            let (line_with_break, has_break) = match memchr(b'\n', rest.as_bytes()) {
                Some(break_index) => (&rest[..=break_index], true),
                None => (rest, false),
            };
            let line = line_with_break
                .strip_suffix('\n')
                .map_or(line_with_break, |line| {
                    line.strip_suffix('\r').unwrap_or(line)
                });
            self.color_line(&grammar, line, utf16_offset, &mut state, &mut spans)
                .map_err(|source| TokenizeError::Pattern { language, source })?;
            byte_offset += line_with_break.len();
            utf16_offset += utf16_length(line_with_break);
            colored_bytes += line_with_break.len();
            hasher.update(line_with_break);
            if has_break {
                settled = SettledLines {
                    state: state.clone(),
                    byte_length: byte_offset,
                    utf16_length: utf16_offset,
                    span_count: spans.len(),
                    hasher: hasher.clone(),
                };
            }
        }
        Ok(TokenizeEnd::Finished(Tokenized {
            spans: Arc::from(spans),
            settled,
            colored_bytes,
        }))
    }

    /// Appends one line's spans, starting at `line_start` UTF-16 units into the source, and moves
    /// `state` past it; a line left plain moves no state.
    fn color_line(
        &self,
        grammar: &Grammar,
        line: &str,
        line_start: u32,
        state: &mut Option<Arc<StateStack>>,
        spans: &mut Vec<u32>,
    ) -> Result<(), RegexError> {
        let line_length = line.encode_utf16().count();
        if line.is_empty() || line_length >= MAX_LINE_LENGTH {
            return Ok(());
        }
        let started = Instant::now();
        #[cfg(test)]
        if let Some(before_line) = &self.before_line {
            before_line(line);
        }
        let result = grammar.tokenize_line2(line, state.clone(), LINE_TIME_LIMIT_MILLIS)?;
        // A search the engine's own limit stopped comes back as no match, so only the clock
        // tells a line that ran out of time.
        if result.stopped_early || started.elapsed() >= self.line_time_limit {
            return Ok(());
        }
        let line_length =
            u32::try_from(line_length).expect("a tokenized line is under 20,000 units");
        let tokens = result.tokens.as_chunks::<2>().0;
        for (index, [token_start, metadata]) in tokens.iter().enumerate() {
            let token_end = tokens
                .get(index + 1)
                .map_or(line_length, |next| next[0])
                .min(line_length);
            let class = usize::try_from(EncodedTokenAttributes::new(*metadata).foreground())
                .ok()
                .and_then(|foreground| self.span_classes.get(foreground).copied().flatten());
            if let Some(class) = class
                && *token_start < token_end
            {
                push_span(
                    spans,
                    line_start + token_start,
                    token_end - token_start,
                    class,
                );
            }
        }
        *state = Some(result.rule_stack);
        Ok(())
    }
}

fn language_grammar(
    grammars: &HashMap<HighlightLanguage, LanguageGrammar>,
    language: HighlightLanguage,
) -> &LanguageGrammar {
    grammars
        .get(&language)
        .expect("every language's grammar is registered when the tokenizer is built")
}

/// The length of `text` in UTF-16 units, as a source's offsets count it.
fn utf16_length(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).expect("a colored source is far under 4 GiB")
}

/// Appends a span, or extends the last one when it ends where this one starts in the same class.
fn push_span(spans: &mut Vec<u32>, offset: u32, length: u32, class: u32) {
    if let Some([last_offset, last_length, last_class]) =
        spans.last_chunk_mut::<HIGHLIGHT_SPAN_WIDTH>()
        && *last_class == class
        && *last_offset + *last_length == offset
    {
        *last_length += length;
        return;
    }
    spans.extend([offset, length, class]);
}

/// The bundled grammars or theme did not load: a fault in the daemon's build.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TokenizerBuildError {
    /// The colorer's theme did not resolve.
    #[error("the colorer's theme did not load")]
    Theme(#[source] ThemeError),
    /// A grammar file did not parse.
    #[error("the {language:?} grammar did not parse")]
    Grammar {
        /// The language whose grammar it is.
        language: HighlightLanguage,
        /// Why it did not parse.
        #[source]
        source: serde_json::Error,
    },
    /// The list of grammars that name scopes from matched text did not parse.
    #[error("the list of grammars that name scopes from matched text did not parse")]
    ScopeList(#[source] serde_json::Error),
}

/// A grammar or one of its patterns did not compile, which fails the read as shiki's throw did.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TokenizeError {
    /// The grammar's rules did not compile against the theme.
    #[error("the {language:?} grammar did not compile")]
    Compile {
        /// The language whose grammar it is.
        language: HighlightLanguage,
        /// Why it did not compile.
        #[source]
        source: ThemeError,
    },
    /// One of the grammar's patterns did not compile.
    #[error("a {language:?} pattern did not compile")]
    Pattern {
        /// The language whose grammar it is.
        language: HighlightLanguage,
        /// Why it did not compile.
        #[source]
        source: RegexError,
    },
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use proptest::prelude::*;
    use rstest::rstest;
    use serde::Deserialize;
    use sidekicks_contracts::highlight::{
        HIGHLIGHT_SPAN_WIDTH, HighlightLanguage, HighlightSpanClass,
    };
    use strum::VariantArray as _;

    use super::{TokenizeEnd, Tokenized, Tokenizer};

    /// The letter the fixture writes for each span class, in wire order.
    const CLASS_LETTERS: &[u8; 11] = b"knsNc+-hHei";

    /// One language's fixture: its source, and the class letter shiki gives each code point.
    #[derive(Deserialize)]
    struct Fixture {
        source: String,
        classes: String,
    }

    fn fixture(language: HighlightLanguage) -> Fixture {
        let mut fixtures: HashMap<HighlightLanguage, Fixture> =
            serde_json::from_str(include_str!("../../tests/fixtures/highlight/classes.json"))
                .expect("the fixture parses");
        fixtures
            .remove(&language)
            .expect("every language has a fixture")
    }

    fn tokenize(tokenizer: &mut Tokenizer, language: HighlightLanguage, source: &str) -> Tokenized {
        let source = Arc::new(source.to_owned());
        finished(
            tokenizer
                .tokenize(|| Some(Arc::clone(&source)), language, None)
                .expect("the grammar compiles"),
        )
    }

    /// The tokenized source of a run whose source stayed held.
    fn finished(end: TokenizeEnd) -> Tokenized {
        match end {
            TokenizeEnd::Finished(tokenized) => Some(tokenized),
            TokenizeEnd::Unwanted(_) => None,
        }
        .expect("the source is held")
    }

    /// One letter per code point: its span's class, or `.` for plain text and every line break.
    fn letters(source: &str, spans: &[u32]) -> String {
        let mut class_by_unit = vec![None; source.encode_utf16().count()];
        for [offset, length, class] in spans.as_chunks::<HIGHLIGHT_SPAN_WIDTH>().0 {
            for unit in *offset..offset + length {
                class_by_unit[unit as usize] = Some(*class);
            }
        }
        let mut unit = 0;
        let mut letters = String::with_capacity(source.len());
        for character in source.chars() {
            letters.push(match class_by_unit[unit] {
                Some(class) if character != '\n' && character != '\r' => {
                    char::from(CLASS_LETTERS[class as usize])
                }
                _ => '.',
            });
            unit += character.len_utf16();
        }
        letters
    }

    // Mutation: map one class's sentinel to the wrong class.
    #[rstest]
    fn colors_each_language_as_shiki_does(
        #[values(
            HighlightLanguage::Bash,
            HighlightLanguage::Css,
            HighlightLanguage::Diff,
            HighlightLanguage::Go,
            HighlightLanguage::Html,
            HighlightLanguage::Javascript,
            HighlightLanguage::Json,
            HighlightLanguage::Jsx,
            HighlightLanguage::Markdown,
            HighlightLanguage::Python,
            HighlightLanguage::Rust,
            HighlightLanguage::Sql,
            HighlightLanguage::Tsx,
            HighlightLanguage::Typescript,
            HighlightLanguage::Yaml
        )]
        language: HighlightLanguage,
    ) {
        let Fixture { source, classes } = fixture(language);
        let mut tokenizer = Tokenizer::build().expect("the tokenizer builds");

        let tokenized = tokenize(&mut tokenizer, language, &source);

        assert_eq!(letters(&source, &tokenized.spans), classes);
    }

    // Mutation: resume at the wrong offset.
    #[rstest]
    fn resumes_at_every_line_boundary_as_one_pass_colors(
        #[values(
            HighlightLanguage::Bash,
            HighlightLanguage::Css,
            HighlightLanguage::Diff,
            HighlightLanguage::Go,
            HighlightLanguage::Html,
            HighlightLanguage::Javascript,
            HighlightLanguage::Json,
            HighlightLanguage::Jsx,
            HighlightLanguage::Markdown,
            HighlightLanguage::Python,
            HighlightLanguage::Rust,
            HighlightLanguage::Sql,
            HighlightLanguage::Tsx,
            HighlightLanguage::Typescript,
            HighlightLanguage::Yaml
        )]
        language: HighlightLanguage,
    ) {
        let Fixture { source, .. } = fixture(language);
        let mut tokenizer = Tokenizer::build().expect("the tokenizer builds");
        let whole = tokenize(&mut tokenizer, language, &source);

        // Each version is the source up to one more line break, resumed where the last settled.
        let mut last = tokenize(&mut tokenizer, language, "");
        let line_ends = source.match_indices('\n').map(|(index, _)| index + 1);
        for version_end in line_ends.chain([source.len()]) {
            let version = Arc::new(source[..version_end].to_owned());
            let resumed = tokenizer
                .tokenize(
                    || Some(Arc::clone(&version)),
                    language,
                    Some((&last.settled, &last.spans[..last.settled.span_count])),
                )
                .expect("the grammar compiles");
            let resumed = finished(resumed);
            let version_units = u32::try_from(version.encode_utf16().count()).expect("fits");
            let expected: Vec<u32> = whole
                .spans
                .as_chunks::<HIGHLIGHT_SPAN_WIDTH>()
                .0
                .iter()
                .filter(|[offset, ..]| *offset < version_units)
                .flatten()
                .copied()
                .collect();
            assert_eq!(
                *resumed.spans, *expected,
                "{language:?} up to byte {version_end}"
            );
            last = resumed;
        }
    }

    // Mutations: count UTF-8 offsets; send an empty line to the engine.
    #[rstest]
    #[case::utf16_offsets_across_crlf(
        HighlightLanguage::Typescript,
        "let a = 1;\r\n// \u{1F600} x\r\nlet b = 2;\n",
        "kkk.....N...cccccc..kkk.....N.."
    )]
    // Sent to the engine, the empty line would end the paragraph and `---` would be a separator.
    #[case::an_empty_line_keeps_the_paragraph_open(
        HighlightLanguage::Markdown,
        "text\n\n---\n",
        "......HHH."
    )]
    fn follows_the_line_rules(
        #[case] language: HighlightLanguage,
        #[case] source: &str,
        #[case] expected: &str,
    ) {
        let mut tokenizer = Tokenizer::build().expect("the tokenizer builds");

        let tokenized = tokenize(&mut tokenizer, language, source);

        assert_eq!(letters(source, &tokenized.spans), expected);
    }

    // Mutation: carry a plain line's state.
    #[rstest]
    #[case::just_under_the_limit(19_999, true)]
    #[case::at_the_limit(20_000, false)]
    fn leaves_a_long_line_plain_and_keeps_the_state_before_it(
        #[case] line_length: usize,
        #[case] is_colored: bool,
    ) {
        let long_line = format!("/*{}", "x".repeat(line_length - 2));
        let source = format!("{long_line}\nlet b = 2;\n");
        let mut tokenizer = Tokenizer::build().expect("the tokenizer builds");

        let tokenized = tokenize(&mut tokenizer, HighlightLanguage::Typescript, &source);

        let expected = if is_colored {
            format!("{}.cccccccccc.", "c".repeat(line_length))
        } else {
            format!("{}.kkk.....N..", ".".repeat(line_length))
        };
        assert_eq!(letters(&source, &tokenized.spans), expected);
    }

    // Mutation: carry the state of a line past the time limit.
    #[test]
    fn leaves_a_line_past_the_time_limit_plain_and_keeps_the_state_before_it() {
        let source = "let a = 1;\n/* HOLD\nlet b = 2;\n";
        let mut tokenizer = Tokenizer::build().expect("the tokenizer builds");
        // Compiled first, so only the held line comes near the limit.
        tokenize(&mut tokenizer, HighlightLanguage::Typescript, source);
        tokenizer.line_time_limit = Duration::from_millis(500);
        tokenizer.set_before_line(Arc::new(|line: &str| {
            if line.contains("HOLD") {
                std::thread::sleep(Duration::from_millis(600));
            }
        }));

        let tokenized = tokenize(&mut tokenizer, HighlightLanguage::Typescript, source);

        assert_eq!(
            letters(source, &tokenized.spans),
            "kkk.....N..........kkk.....N.."
        );
    }

    thread_local! {
        static SHARED_TOKENIZER: RefCell<Tokenizer> =
            RefCell::new(Tokenizer::build().expect("the tokenizer builds"));
    }

    proptest! {
        #[test]
        fn any_text_gives_ordered_spans_inside_it(
            language in proptest::sample::select(HighlightLanguage::VARIANTS),
            source in "(?s).{0,300}",
        ) {
            let source = Arc::new(source);
            let tokenized = SHARED_TOKENIZER
                .with_borrow_mut(|tokenizer| {
                    tokenizer.tokenize(|| Some(Arc::clone(&source)), language, None)
                })
                .expect("the grammar compiles");
            let tokenized = finished(tokenized);

            let (spans, rest) = tokenized.spans.as_chunks::<HIGHLIGHT_SPAN_WIDTH>();
            prop_assert!(rest.is_empty());
            let mut previous_end = 0;
            for [offset, length, class] in spans {
                prop_assert!(*offset >= previous_end && *length > 0);
                prop_assert!((*class as usize) < HighlightSpanClass::VARIANTS.len());
                previous_end = offset + length;
            }
            prop_assert!(previous_end as usize <= source.encode_utf16().count());
        }
    }
}
