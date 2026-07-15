use std::str;

/// A bounded terminal transcript used to replay output after attaching.
pub(super) struct ReplayBuffer {
    data: String,
    max_bytes: usize,
}

impl ReplayBuffer {
    pub(super) fn new(max_bytes: usize) -> Self {
        Self {
            data: String::new(),
            max_bytes,
        }
    }

    pub(super) fn set_limit(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        self.trim_to_max();
    }

    pub(super) fn push(&mut self, chunk: &str) {
        // A terminal reset or full-screen erase makes prior output misleading on replay.
        if chunk.contains("\x1bc") || chunk.contains("\x1b[2J") || chunk.contains("\x1b[3J") {
            self.data.clear();
        }
        self.data.push_str(chunk);
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
