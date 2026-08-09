use std::str;

const MAX_GRAPHICS_SEQUENCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DCS_INTRO_BYTES: usize = 64;

/// A bounded terminal transcript used to replay output after attaching.
pub(super) struct ReplayBuffer {
    data: String,
    max_bytes: usize,
    sanitizer: ReplayGraphicsSanitizer,
}

impl ReplayBuffer {
    pub(super) fn new(max_bytes: usize) -> Self {
        Self {
            data: String::new(),
            max_bytes,
            sanitizer: ReplayGraphicsSanitizer::default(),
        }
    }

    pub(super) fn set_limit(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        self.trim_to_max();
    }

    pub(super) fn push(&mut self, chunk: &str) {
        let safe = self.sanitizer.push(chunk);
        if safe.is_empty() {
            return;
        }
        // A terminal reset or full-screen erase makes prior output misleading on replay.
        if safe.contains("\x1bc") || safe.contains("\x1b[2J") || safe.contains("\x1b[3J") {
            self.data.clear();
        }
        self.data.push_str(&safe);
        self.trim_to_max();
    }

    fn trim_to_max(&mut self) {
        if self.data.len() <= self.max_bytes {
            return;
        }
        let mut drain_end = self.data.len() - self.max_bytes;
        // Keep the transcript valid UTF-8 even when its byte limit bisects a character.
        while drain_end < self.data.len() && !self.data.is_char_boundary(drain_end) {
            drain_end += 1;
        }
        self.data.drain(..drain_end);
    }

    pub(super) fn text(&self) -> String {
        self.data.clone()
    }
}

/// Incrementally strips terminal graphics sequences that must not be replayed.
///
/// Omits OSC 777 preview commands, OSC 1337 IIP (`File=`), SIXEL DCS, and Kitty
/// APC graphics (`ESC _G ... ST`), including sequences split across chunks.
/// Normal text, UTF-8, and non-graphics ANSI escape sequences are preserved.
#[derive(Default)]
struct ReplayGraphicsSanitizer {
    mode: Mode,
    /// Bytes collected while classifying an OSC/DCS introducer.
    intro: Vec<u8>,
    /// Bounds malformed graphics sequences so they cannot suppress replay forever.
    stripped_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Normal,
    Esc,
    OscClassify,
    OscPass,
    OscStrip,
    DcsClassify,
    DcsPass,
    DcsStrip,
    ApcClassify,
    ApcPass,
    ApcStrip,
    /// Saw ESC inside a string sequence; next byte may complete ST (`\`).
    ExpectSt {
        /// When true, emit the ST (or the lone ESC) into output.
        emit: bool,
        /// Mode to resume when the ESC was not ST.
        resume: Resume,
    },
}

impl Default for Mode {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Resume {
    OscPass,
    OscStrip,
    DcsPass,
    DcsStrip,
    ApcPass,
    ApcStrip,
}

impl Resume {
    fn mode(self) -> Mode {
        match self {
            Self::OscPass => Mode::OscPass,
            Self::OscStrip => Mode::OscStrip,
            Self::DcsPass => Mode::DcsPass,
            Self::DcsStrip => Mode::DcsStrip,
            Self::ApcPass => Mode::ApcPass,
            Self::ApcStrip => Mode::ApcStrip,
        }
    }
}

impl ReplayGraphicsSanitizer {
    fn push(&mut self, chunk: &str) -> String {
        let mut out = Vec::with_capacity(chunk.len());
        for &byte in chunk.as_bytes() {
            self.step(byte, &mut out);
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn step(&mut self, byte: u8, out: &mut Vec<u8>) {
        match self.mode {
            Mode::Normal => {
                if byte == 0x1b {
                    self.mode = Mode::Esc;
                } else {
                    out.push(byte);
                }
            }
            Mode::Esc => match byte {
                b']' => {
                    self.intro.clear();
                    self.mode = Mode::OscClassify;
                }
                b'P' => {
                    self.intro.clear();
                    self.mode = Mode::DcsClassify;
                }
                b'_' => {
                    self.mode = Mode::ApcClassify;
                }
                _ => {
                    out.push(0x1b);
                    out.push(byte);
                    self.mode = Mode::Normal;
                }
            },
            Mode::OscClassify => {
                if byte == 0x07 {
                    out.push(0x1b);
                    out.push(b']');
                    out.extend_from_slice(&self.intro);
                    out.push(0x07);
                    self.intro.clear();
                    self.mode = Mode::Normal;
                } else if byte == 0x1b {
                    out.push(0x1b);
                    out.push(b']');
                    out.extend_from_slice(&self.intro);
                    self.intro.clear();
                    self.mode = Mode::Esc;
                } else {
                    self.intro.push(byte);
                    match classify_osc(&self.intro) {
                        OscDecision::NeedMore => {}
                        OscDecision::Strip => {
                            self.intro.clear();
                            self.stripped_bytes = 0;
                            self.mode = Mode::OscStrip;
                        }
                        OscDecision::Pass => {
                            out.push(0x1b);
                            out.push(b']');
                            out.extend_from_slice(&self.intro);
                            self.intro.clear();
                            self.mode = Mode::OscPass;
                        }
                    }
                }
            }
            Mode::OscPass => {
                if byte == 0x07 {
                    out.push(byte);
                    self.mode = Mode::Normal;
                } else if byte == 0x1b {
                    self.mode = Mode::ExpectSt {
                        emit: true,
                        resume: Resume::OscPass,
                    };
                } else {
                    out.push(byte);
                }
            }
            Mode::OscStrip => {
                if byte == 0x07 {
                    self.finish_strip();
                } else if byte == b'\n' {
                    // A malformed unterminated OSC must not swallow a later shell prompt.
                    out.push(byte);
                    self.finish_strip();
                } else if byte == 0x1b {
                    self.mode = Mode::ExpectSt {
                        emit: false,
                        resume: Resume::OscStrip,
                    };
                } else {
                    self.count_stripped_byte(byte, out);
                }
            }
            Mode::DcsClassify => {
                if byte == 0x1b {
                    out.push(0x1b);
                    out.push(b'P');
                    out.extend_from_slice(&self.intro);
                    self.intro.clear();
                    self.mode = Mode::Esc;
                } else {
                    self.intro.push(byte);
                    if byte == b'q' {
                        self.intro.clear();
                        self.stripped_bytes = 0;
                        self.mode = Mode::DcsStrip;
                    } else if !is_sixel_param_byte(byte) || self.intro.len() > MAX_DCS_INTRO_BYTES {
                        out.push(0x1b);
                        out.push(b'P');
                        out.extend_from_slice(&self.intro);
                        self.intro.clear();
                        self.mode = Mode::DcsPass;
                    }
                }
            }
            Mode::DcsPass => {
                if byte == 0x1b {
                    self.mode = Mode::ExpectSt {
                        emit: true,
                        resume: Resume::DcsPass,
                    };
                } else {
                    out.push(byte);
                }
            }
            Mode::DcsStrip => {
                if byte == b'\n' {
                    out.push(byte);
                    self.finish_strip();
                } else if byte == 0x1b {
                    self.mode = Mode::ExpectSt {
                        emit: false,
                        resume: Resume::DcsStrip,
                    };
                } else {
                    self.count_stripped_byte(byte, out);
                }
            }
            Mode::ApcClassify => {
                if byte == b'G' {
                    self.stripped_bytes = 0;
                    self.mode = Mode::ApcStrip;
                } else if byte == 0x1b {
                    out.push(0x1b);
                    out.push(b'_');
                    self.mode = Mode::Esc;
                } else {
                    out.push(0x1b);
                    out.push(b'_');
                    out.push(byte);
                    self.mode = Mode::ApcPass;
                }
            }
            Mode::ApcPass => {
                if byte == 0x1b {
                    self.mode = Mode::ExpectSt {
                        emit: true,
                        resume: Resume::ApcPass,
                    };
                } else {
                    out.push(byte);
                }
            }
            Mode::ApcStrip => {
                if byte == b'\n' {
                    out.push(byte);
                    self.finish_strip();
                } else if byte == 0x1b {
                    self.mode = Mode::ExpectSt {
                        emit: false,
                        resume: Resume::ApcStrip,
                    };
                } else {
                    self.count_stripped_byte(byte, out);
                }
            }
            Mode::ExpectSt { emit, resume } => {
                if byte == b'\\' {
                    if emit {
                        out.push(0x1b);
                        out.push(b'\\');
                        self.mode = Mode::Normal;
                    } else {
                        self.finish_strip();
                    }
                } else {
                    // Not ST: keep the ESC visible for pass-through sequences, then resume.
                    if emit {
                        out.push(0x1b);
                    }
                    self.mode = resume.mode();
                    self.step(byte, out);
                }
            }
        }
    }

    fn finish_strip(&mut self) {
        self.stripped_bytes = 0;
        self.mode = Mode::Normal;
    }

    fn count_stripped_byte(&mut self, byte: u8, out: &mut Vec<u8>) {
        self.stripped_bytes += 1;
        if self.stripped_bytes > MAX_GRAPHICS_SEQUENCE_BYTES {
            self.finish_strip();
            self.step(byte, out);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum OscDecision {
    NeedMore,
    Strip,
    Pass,
}

fn classify_osc(body: &[u8]) -> OscDecision {
    if body.starts_with(b"777") {
        return OscDecision::Strip;
    }
    if b"777".starts_with(body) {
        return OscDecision::NeedMore;
    }

    if body.starts_with(b"1337;File=") {
        return OscDecision::Strip;
    }
    if b"1337;File=".starts_with(body) {
        return OscDecision::NeedMore;
    }
    if body.starts_with(b"1337;") {
        let rest = &body[b"1337;".len()..];
        if rest.is_empty() {
            return OscDecision::NeedMore;
        }
        if b"File=".starts_with(rest) {
            return OscDecision::NeedMore;
        }
        return OscDecision::Pass;
    }
    if b"1337;".starts_with(body) {
        return OscDecision::NeedMore;
    }

    OscDecision::Pass
}

fn is_sixel_param_byte(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b';' | b' ' | b'?')
}

/// Incrementally decodes PTY bytes without corrupting characters split across reads.
#[derive(Default)]
pub(super) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            match str::from_utf8(&self.pending) {
                Ok(valid) => {
                    if !valid.is_empty() {
                        out.push(valid.to_string());
                    }
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        out.push(String::from_utf8_lossy(&self.pending[..valid_up_to]).to_string());
                        self.pending.drain(..valid_up_to);
                    } else if let Some(error_len) = err.error_len() {
                        // Invalid complete sequences are replaced now; incomplete tails wait for the next read.
                        out.push(String::from_utf8_lossy(&self.pending[..error_len]).to_string());
                        self.pending.drain(..error_len);
                    } else {
                        break;
                    }
                }
            }
        }
        out
    }

    pub(super) fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            // EOF makes an incomplete sequence definitively invalid, so emit its lossy replacement.
            let data = String::from_utf8_lossy(&self.pending).to_string();
            self.pending.clear();
            Some(data)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitize_all(chunks: &[&str]) -> String {
        let mut sanitizer = ReplayGraphicsSanitizer::default();
        let mut out = String::new();
        for chunk in chunks {
            out.push_str(&sanitizer.push(chunk));
        }
        out
    }

    #[test]
    fn preserves_plain_text_ansi_and_utf8() {
        let text = "hello \x1b[31mred\x1b[0m café 你好";
        assert_eq!(sanitize_all(&[text]), text);
    }

    #[test]
    fn strips_osc_777_with_bel_and_st() {
        assert_eq!(
            sanitize_all(&["pre\x1b]777;swath-image=abc\x07post"]),
            "prepost"
        );
        assert_eq!(
            sanitize_all(&["pre\x1b]777;swath-image=abc\x1b\\post"]),
            "prepost"
        );
    }

    #[test]
    fn strips_osc_777_split_across_chunks() {
        assert_eq!(
            sanitize_all(&["pre\x1b]77", "7;swath-image=ab", "c\x07post"]),
            "prepost"
        );
    }

    #[test]
    fn strips_osc_1337_iip_but_keeps_other_1337() {
        assert_eq!(sanitize_all(&["a\x1b]1337;File=name=x:AA==\x07b"]), "ab");
        assert_eq!(
            sanitize_all(&["a\x1b]1337;RemoteHost=host\x07b"]),
            "a\x1b]1337;RemoteHost=host\x07b"
        );
    }

    #[test]
    fn strips_sixel_dcs_and_kitty_apc() {
        assert_eq!(sanitize_all(&["x\x1bP0;0;0q#0;2;0;0;0\x1b\\y"]), "xy");
        assert_eq!(
            sanitize_all(&["x\x1b_Ga=T;f=100;s=1;v=1;m=0;ABCDEF\x1b\\y"]),
            "xy"
        );
    }

    #[test]
    fn strips_kitty_and_sixel_when_chunk_split() {
        assert_eq!(sanitize_all(&["a\x1b_", "Ga=T;xx", "\x1b", "\\b"]), "ab");
        assert_eq!(sanitize_all(&["a\x1bP0;1", "qDATA", "\x1b\\b"]), "ab");
    }

    #[test]
    fn replay_buffer_omits_graphics_from_stored_text() {
        let mut buf = ReplayBuffer::new(64 * 1024);
        buf.push("hello ");
        buf.push("\x1b]777;swath-image=qq\x07");
        buf.push("world");
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn malformed_graphics_sequence_recovers_at_newline() {
        assert_eq!(
            sanitize_all(&["before\x1b]777;unterminated", "\nafter"]),
            "before\nafter"
        );
    }

    #[test]
    fn long_dcs_introducer_is_bounded_and_passed_through() {
        let intro = "1".repeat(MAX_DCS_INTRO_BYTES + 1);
        let sequence = format!("\x1bP{intro}X");
        assert_eq!(sanitize_all(&[&sequence]), sequence);
    }
}
