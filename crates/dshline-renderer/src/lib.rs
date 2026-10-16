//! Pure presentation transformations. Text is lossless JavaScript UTF-16, not UTF-8.
//!
//! All state is explicit: `MarkdownState` and an already-resolved `Palette`.
//! No terminal, Node, agent, process-global palette, or I/O enters these functions.
//! The verification CLI's `protocol` module admits bounded requests before work;
//! direct library callers own their presentation-data admission policy.
//!
//! Width uses the project's fixed Unicode 17 code-point tables, not graphemes.
//! Markdown word flanking uses Unicode 17 L/N properties (the verified Node 24
//! oracle); integration must account for other host Unicode versions before
//! enabling native markdown. No runtime selector or bindings are provided here.
//! Narrow CSI/OSC recognition and full-reset replay deliberately mirror TS,
//! including malformed escapes and non-scalar UTF-16 values.
mod tables;
mod lookup;
pub type Text = Vec<u16>;
pub fn text(s: &str) -> Text {
    s.encode_utf16().collect()
}
fn append(a: &mut Text, b: &[u16]) {
    a.extend_from_slice(b);
}
fn cat(parts: &[&[u16]]) -> Text {
    parts.concat()
}
fn reset() -> Text {
    text("\x1b[0m")
}
fn ranges(r: &[(u32, u32)], c: u32) -> bool {
    r.binary_search_by(|&(a, b)| {
        if c < a {
            std::cmp::Ordering::Greater
        } else if c > b {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    })
    .is_ok()
}
// Keep the compact lookup out of the ASCII scanner's hot loop. Automatic
// inlining grew that loop and regressed plain ASCII despite faster Unicode.
#[inline(never)]
pub fn code_point_width(c: u32) -> i32 {
    if c < 32 || (127..160).contains(&c) {
        0
    } else if c < 127 {
        1
    } else if c <= 0x10ffff {
        lookup::PAGES[lookup::INDEX[(c >> 8) as usize] as usize][(c & 255) as usize] as i32
    } else {
        1
    }
}
#[cfg(test)]
mod lookup_tests {
    use super::*;
    #[test]
    fn every_codepoint_matches_original_range_policy() {
        for c in 0..=0x10ffff {
            let expected = if c < 32 || (127..160).contains(&c) { 0 }
                else if c < 127 { 1 }
                else if ranges(tables::ZERO_WIDTH_RANGES, c) { 0 }
                else if ranges(tables::WIDE_RANGES, c) { 2 }
                else { 1 };
            assert_eq!(code_point_width(c), expected, "code point {c:x}");
        }
        assert_eq!(code_point_width(0x110000), 1);
        assert_eq!(code_point_width(u32::MAX), 1);
    }
}
fn point(s: &[u16], i: usize) -> (u32, usize) {
    let a = s[i];
    if (0xd800..=0xdbff).contains(&a) && s.get(i + 1).is_some_and(|b| (0xdc00..=0xdfff).contains(b))
    {
        (
            0x10000 + ((a as u32 - 0xd800) << 10) + (s[i + 1] as u32 - 0xdc00),
            2,
        )
    } else {
        (a as u32, 1)
    }
}
fn ansi_end(s: &[u16], i: usize) -> Option<usize> {
    if s.get(i) != Some(&27) {
        return None;
    }
    let mut j = i + 2;
    match s.get(i + 1) {
        Some(91) => {
            while s.get(j).is_some_and(|c| matches!(*c, 48..=57 | 59 | 63)) {
                j += 1
            }
            while s.get(j).is_some_and(|c| (32..=47).contains(c)) {
                j += 1
            }
            s.get(j).filter(|c| (64..=126).contains(*c)).map(|_| j + 1)
        }
        Some(93) => {
            while let Some(&c) = s.get(j) {
                if c == 7 {
                    return Some(j + 1);
                }
                if c == 27 {
                    return if s.get(j + 1) == Some(&92) {
                        Some(j + 2)
                    } else {
                        None
                    };
                }
                j += 1
            }
            None
        }
        _ => None,
    }
}
#[derive(Clone, Copy, Debug)]
struct Token<'a> {
    v: &'a [u16],
    w: i32,
    esc: bool,
}
// Borrow source spans instead of allocating a Vec for every character. Prefix
// consumers stop scanning at their budget; measurements allocate no tokens.
fn tokens(s: &[u16]) -> impl Iterator<Item = Token<'_>> {
    let mut i = 0;
    std::iter::from_fn(move || {
        if i == s.len() {
            return None;
        }
        let start = i;
        let (w, esc) = if let Some(end) = ansi_end(s, i) {
            i = end;
            (0, true)
        } else {
            let (c, n) = point(s, i);
            i += n;
            (code_point_width(c), c == 27)
        };
        Some(Token {
            v: &s[start..i],
            w,
            esc,
        })
    })
}
fn closes(s: &[u16]) -> bool {
    s == [27, 91, 109] || s == [27, 91, 48, 109]
}
fn joined(t: &[Token<'_>]) -> Text {
    t.iter().flat_map(|t| t.v.iter().copied()).collect()
}
fn width(t: &[Token<'_>]) -> i32 {
    t.iter().map(|t| t.w).sum()
}
pub fn display_width(s: &[u16]) -> i32 {
    let mut total = 0;
    let mut i = 0;
    while i < s.len() {
        let unit = s[i];
        if unit < 127 {
            if unit == 27 {
                if let Some(end) = ansi_end(s, i) {
                    i = end;
                    continue;
                }
            } else if unit >= 32 {
                total += 1;
            }
            i += 1;
        } else {
            let (code, length) = point(s, i);
            total += code_point_width(code);
            i += length;
        }
    }
    total
}
pub fn strip_ansi(s: &[u16]) -> Text {
    let mut out = vec![];
    let mut i = 0;
    while i < s.len() {
        if let Some(e) = ansi_end(s, i) {
            i = e
        } else {
            out.push(s[i]);
            i += 1
        }
    }
    out
}
pub fn truncate(s: &[u16], n: i32) -> Text {
    truncate_measured(s, n).0
}
fn truncate_measured(s: &[u16], n: i32) -> (Text, i32) {
    if n <= 0 {
        return (vec![], 0);
    }
    let mut out = vec![];
    let mut used = 0;
    let mut open = false;
    for t in tokens(s) {
        if t.w == 0 {
            if t.esc {
                open = !closes(t.v)
            }
        } else if used + t.w > n {
            if open {
                append(&mut out, &reset())
            }
            return (out, used);
        }
        used += t.w;
        append(&mut out, t.v)
    }
    (out, used)
}
pub fn tail(s: &[u16], n: i32) -> Text {
    if n <= 0 {
        return vec![];
    }
    let ts: Vec<_> = tokens(s).collect();
    let mut used = 0;
    let mut from = ts.len();
    for i in (0..ts.len()).rev() {
        if used + ts[i].w > n {
            break;
        }
        used += ts[i].w;
        from = i
    }
    let mut out = vec![];
    if from > 0 {
        while from < ts.len() && ts[from].w == 0 {
            if ts[from].esc {
                append(&mut out, ts[from].v)
            }
            from += 1
        }
    }
    append(&mut out, &joined(&ts[from..]));
    out
}
pub fn split_columns(s: &[u16], from: i32, to: i32) -> [Text; 3] {
    let mut col = 0;
    let mut start = 0;
    let mut end = s.len();
    let mut prev = 0;
    let mut indicators = 0;
    let mut at = 0;
    for t in tokens(s) {
        let (c, _) = point(s, at);
        if t.w > 0 {
            let regional = (0x1f1e6..=0x1f1ff).contains(&c);
            let join = prev == 0x200d || (regional && indicators % 2 == 1);
            indicators = if regional { indicators + 1 } else { 0 };
            if !join {
                if col >= to {
                    end = at;
                    break;
                }
                if col <= from {
                    start = at
                }
            }
            col += t.w
        }
        prev = c;
        at += t.v.len()
    }
    [
        s[..start].to_vec(),
        s[start..end].to_vec(),
        s[end..].to_vec(),
    ]
}
pub fn chunk(s: &[u16], n: i32) -> Vec<Text> {
    let budget = n.max(1);
    let mut out = vec![];
    for p in s.split(|c| *c == 10) {
        let mut row = vec![];
        let mut used = 0;
        let mut open = vec![];
        for t in tokens(p) {
            if t.w == 0 {
                if t.esc {
                    if closes(t.v) {
                        open.clear()
                    } else {
                        append(&mut open, t.v)
                    }
                }
                append(&mut row, t.v);
                continue;
            }
            if used + t.w > budget {
                if !open.is_empty() {
                    append(&mut row, &reset())
                }
                out.push(row);
                row = open.clone();
                used = 0
            }
            append(&mut row, t.v);
            used += t.w
        }
        if !open.is_empty() {
            append(&mut row, &reset())
        }
        out.push(row)
    }
    out
}
pub fn wrap(s: &[u16], n: i32) -> Vec<Text> {
    let budget = n.max(1);
    let mut out = vec![];
    for p in s.split(|c| *c == 10) {
        if p.is_empty() {
            out.push(vec![]);
            continue;
        }
        let mut row: Vec<Token<'_>> = vec![];
        let mut used = 0;
        let mut open: Text = vec![];
        let mut prefix: Text = vec![];
        let mut last: Option<usize> = None;
        let mut last_open = vec![];
        let mut broken = false;
        for t in tokens(p) {
            if t.w == 0 {
                if t.esc {
                    if closes(t.v) {
                        open.clear()
                    } else {
                        append(&mut open, t.v)
                    }
                }
                row.push(t);
                continue;
            }
            if used == 0 && t.w > budget {
                row.push(t);
                let mut line = cat(&[&prefix, &joined(&row)]);
                if !open.is_empty() {
                    append(&mut line, &reset())
                }
                out.push(line);
                prefix = open.clone();
                row.clear();
                last = None;
                used = 0;
                broken = true;
                continue;
            }
            while used > 0 && used + t.w > budget {
                let split = last.unwrap_or(row.len());
                let break_open = if last.is_some() {
                    last_open.clone()
                } else {
                    open.clone()
                };
                let mut line = cat(&[&prefix, &joined(&row[..split])]);
                if !break_open.is_empty() {
                    append(&mut line, &reset())
                }
                out.push(line);
                prefix = break_open;
                let rest = if split < row.len() && row[split].v == [32] {
                    split + 1
                } else {
                    split
                };
                row = row[rest..].to_vec();
                used = width(&row);
                last = None;
                last_open.clear();
                broken = true
            }
            if t.v == [32] && used == 0 && broken {
                continue;
            }
            if t.v == [32] {
                last = Some(row.len());
                last_open = open.clone()
            }
            used += t.w;
            row.push(t)
        }
        if width(&row) > 0 || out.is_empty() {
            let mut line = cat(&[&prefix, &joined(&row)]);
            if !open.is_empty() {
                append(&mut line, &reset())
            }
            out.push(line)
        }
    }
    if out.is_empty() {
        out.push(vec![])
    }
    out
}
pub fn fit(s: &[u16], n: i32) -> Text {
    if n <= 0 {
        // At zero columns the original fit preserves an entirely zero-width
        // source; truncate(0) does not. Negative budgets always produce empty.
        return if n == 0 && display_width(s) == 0 { s.to_vec() } else { vec![] };
    }
    // Short/already-fitted rows benefit from a cheap scan plus one clone. Long
    // inputs commonly need only a prefix; do not scan their entire suffix just
    // to discard it, or remeasure a prefix whose exact width we already know.
    const PREFIX_SCAN_RATIO: usize = 4;
    let (mut out, used) = if s.len() > (n as usize).saturating_mul(PREFIX_SCAN_RATIO) {
        truncate_measured(s, n)
    } else {
        let used = display_width(s);
        if used > n { truncate_measured(s, n) } else { (s.to_vec(), used) }
    };
    let pad = (n - used).max(0) as usize;
    out.extend(std::iter::repeat_n(32, pad));
    out
}
pub fn hanging(mark: &[u16], indent: &[u16], s: &[u16], n: i32) -> Vec<Text> {
    wrap(
        s,
        (n - display_width(mark).max(display_width(indent))).max(1),
    )
    .iter()
    .enumerate()
    .map(|(i, r)| {
        let line = cat(&[if i == 0 { mark } else { indent }, r]);
        if display_width(&line) > n {
            truncate(&line, n)
        } else {
            line
        }
    })
    .collect()
}
pub fn sgr(s: &[u16], p: &[i32]) -> Text {
    if p.is_empty() {
        return s.to_vec();
    }
    let params = p.iter().map(i32::to_string).collect::<Vec<_>>().join(";");
    cat(&[&text(&format!("\x1b[{params}m")), s, &reset()])
}
pub fn escape(s: &[u16]) -> Text {
    let mut escaped = vec![];
    for &c in s {
        if c <= 8 || (11..=31).contains(&c) {
            append(&mut escaped, &[94, c + 64])
        } else if c == 127 {
            append(&mut escaped, &text("^?"))
        } else if (128..160).contains(&c) {
            append(&mut escaped, &text(&format!("\\u{{{c:x}}}")))
        } else {
            escaped.push(c)
        }
    }
    let mut out = vec![];
    let mut col = 0;
    let mut i = 0;
    while i < escaped.len() {
        let (c, n) = point(&escaped, i);
        if c == 9 {
            let spaces = 8 - col % 8;
            out.extend(std::iter::repeat_n(32, spaces));
            col += spaces
        } else {
            append(&mut out, &escaped[i..i + n]);
            if c == 10 { col = 0 } else { col += 1 }
        }
        i += n
    }
    out
}
pub fn sanitize(s: &[u16]) -> Text {
    let mut out = vec![];
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            13 => {
                out.push(10);
                if s.get(i + 1) == Some(&10) {
                    i += 1
                }
            }
            9 => append(&mut out, &text("    ")),
            _ => out.push(s[i]),
        }
        i += 1
    }
    escape(&out)
}
use std::collections::BTreeMap;
#[derive(Clone, Debug)]
pub struct Palette {
    pub id: Text,
    pub depth: i32,
    pub roles: BTreeMap<Text, Vec<i32>>,
}
impl Default for Palette {
    fn default() -> Self {
        let mut roles = BTreeMap::new();
        for (r, p) in [
            ("heading-1", vec![1, 36]),
            ("heading-2", vec![1]),
            ("heading-3", vec![1, 2]),
            ("strong", vec![1]),
            ("emphasis", vec![3]),
            ("strike", vec![2]),
            ("code", vec![36]),
            ("link", vec![36]),
            ("link-target", vec![90]),
            ("quote", vec![2]),
            ("quote-bar", vec![90]),
            ("bullet", vec![90]),
            ("rule", vec![90]),
            ("muted", vec![90]),
        ] {
            roles.insert(text(r), p);
        }
        Self {
            id: text("markdown"),
            depth: 4,
            roles,
        }
    }
}
fn paint(s: &[u16], role: &str, p: &Palette) -> Text {
    if p.depth == 0 {
        return s.to_vec();
    }
    sgr(
        s,
        p.roles.get(&text(role)).map(Vec::as_slice).unwrap_or(&[]),
    )
}
fn white(c: u16) -> bool {
    matches!(c,9..=13|32|160|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn word(c: u32) -> bool {
    ranges(tables::WORD_RANGES, c)
}
fn prev_point(s: &[u16], i: usize) -> u32 {
    if i == 0 {
        return 0;
    }
    if i >= 2 && (0xd800..=0xdbff).contains(&s[i - 2]) && (0xdc00..=0xdfff).contains(&s[i - 1]) {
        point(s, i - 2).0
    } else {
        s[i - 1] as u32
    }
}
fn find(s: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > s.len() {
        return None;
    }
    s[from..]
        .windows(needle.len())
        .position(|v| v == needle)
        .map(|i| i + from)
}
pub fn inline(s: &[u16], p: &Palette) -> Text {
    let mut out = vec![];
    let mut plain = 0;
    let mut at = 0;
    while at < s.len() {
        let mut matched: Option<(usize, Text)> = None;
        let c = s[at];
        if c == 91 && s.get(at + 1) != Some(&93) {
            if let Some(close) = find(s, &[93], at + 2) {
                if s.get(close + 1) == Some(&40) {
                    let end = (close + 2..s.len()).find(|&i| s[i] == 41 || white(s[i]));
                    if let Some(end) = end {
                        if end > close + 2 && s[end] == 41 {
                            matched = Some((
                                end + 1,
                                cat(&[
                                    &paint(&escape(&s[at + 1..close]), "link", p),
                                    &paint(
                                        &cat(&[
                                            &text(" ("),
                                            &escape(&s[close + 2..end]),
                                            &text(")"),
                                        ]),
                                        "link-target",
                                        p,
                                    ),
                                ]),
                            ))
                        }
                    }
                }
            }
        } else if c == 96 {
            let mut start = at;
            while s.get(start) == Some(&96) {
                start += 1
            }
            if let Some(close) = find(s, &[96], start) {
                let mut end = close;
                while s.get(end) == Some(&96) {
                    end += 1
                }
                if close > start && end - close >= start - at {
                    matched = Some((
                        close + start - at,
                        paint(&escape(&s[start..close]), "code", p),
                    ))
                }
            }
        } else if matches!(c, 42 | 95 | 126) {
            for (delimiter, role, intraword, veto) in [
                ("**", "strong", true, false),
                ("__", "strong", false, true),
                ("~~", "strike", true, false),
                ("*", "emphasis", true, false),
                ("_", "emphasis", false, false),
            ] {
                let d = text(delimiter);
                if s.get(at..at + d.len()) != Some(d.as_slice())
                    || prev_point(s, at) == c as u32
                    || s.get(at + d.len()) == Some(&c)
                    || (!intraword && word(prev_point(s, at)))
                {
                    continue;
                }
                let start = at + d.len();
                if start >= s.len() || white(s[start]) {
                    continue;
                }
                let mut search = start + 1;
                let mut close = None;
                while let Some(i) = find(s, &d, search) {
                    let after = s.get(i + d.len()).copied();
                    if !white(s[i - 1])
                        && (intraword || after.is_none() || !word(after.unwrap_or(0) as u32))
                    {
                        close = Some(i);
                        break;
                    }
                    search = i + 1
                }
                if let Some(close) = close {
                    let content = &s[start..close];
                    let identifier = !content.is_empty() && {
                        let mut i = 0;
                        let mut yes = true;
                        while i < content.len() {
                            let (c, n) = point(content, i);
                            yes &= c == 95 || word(c);
                            i += n
                        }
                        yes
                    };
                    if veto && identifier {
                        continue;
                    }
                    matched = Some((close + d.len(), paint(&escape(content), role, p)));
                    break;
                }
            }
        }
        if let Some((end, v)) = matched {
            append(&mut out, &escape(&s[plain..at]));
            append(&mut out, &v);
            at = end;
            plain = at
        } else {
            at += 1
        }
    }
    append(&mut out, &escape(&s[plain..]));
    out
}
#[derive(Clone, Debug, Default)]
pub struct MarkdownState {
    pub fence: Option<Text>,
}
fn fence_line(s: &[u16], p: &Palette) -> Text {
    cat(&[&text("  "), &paint(&escape(s), "code", p)])
}
fn trim(s: &[u16]) -> &[u16] {
    let a = s.iter().position(|&c| !white(c)).unwrap_or(s.len());
    let b = s
        .iter()
        .rposition(|&c| !white(c))
        .map(|i| i + 1)
        .unwrap_or(a);
    &s[a..b]
}
fn line(s: &[u16], state: &mut MarkdownState, p: &Palette) -> Vec<Text> {
    let spaces = s.iter().take_while(|&&c| c == 32).count();
    if spaces <= 3 {
        let mut end = spaces;
        let c = s.get(spaces).copied().unwrap_or(0);
        if c == 96 || c == 126 {
            while s.get(end) == Some(&c) {
                end += 1
            }
            if end - spaces >= 3
                && !s[end..]
                    .iter()
                    .any(|&c| matches!(c, 10 | 13 | 0x2028 | 0x2029))
            {
                let marker = s[spaces..end].to_vec();
                let info = trim(&s[end..]);
                if state.fence.is_none() {
                    state.fence = Some(marker);
                    return if info.is_empty() {
                        vec![]
                    } else {
                        vec![paint(&escape(info), "muted", p)]
                    };
                }
                if state
                    .fence
                    .as_ref()
                    .is_some_and(|f| f[0] == c && marker.len() >= f.len())
                    && info.is_empty()
                {
                    state.fence = None;
                    return vec![];
                }
            }
        }
    }
    if state.fence.is_some() {
        return vec![fence_line(s, p)];
    }
    let hashes = s.iter().take_while(|&&c| c == 35).count();
    if (1..=6).contains(&hashes) && s.get(hashes).is_some_and(|c| matches!(*c, 9 | 32)) {
        let mut end = hashes;
        while s.get(end).is_some_and(|c| matches!(*c, 9 | 32)) {
            end += 1
        }
        return vec![paint(
            &escape(&s[end..]),
            ["heading-1", "heading-2", "heading-3"][hashes.min(3) - 1],
            p,
        )];
    }
    let rule: Text = s
        .iter()
        .copied()
        .filter(|c| !matches!(*c, 9 | 32))
        .collect();
    if rule.len() >= 3 && matches!(rule[0], 45 | 42 | 95) && rule.iter().all(|&c| c == rule[0]) {
        return vec![paint(&text("───"), "rule", p)];
    }
    let indent = s.iter().take_while(|&&c| matches!(c, 9 | 32)).count();
    if indent <= 64 {
        if s.get(indent) == Some(&62) {
            let end =
                indent + 1 + usize::from(s.get(indent + 1).is_some_and(|c| matches!(*c, 9 | 32)));
            return vec![cat(&[
                &paint(&text("▏"), "quote-bar", p),
                &text(" "),
                &paint(&inline(&s[end..], p), "quote", p),
            ])];
        }
        let mut marker = None;
        if s.get(indent).is_some_and(|c| matches!(*c, 45 | 42 | 43)) {
            marker = Some((indent + 1, text(["•", "◦", "‣"][(indent / 2).min(2)])))
        } else {
            let mut end = indent;
            while s.get(end).is_some_and(|c| (48..=57).contains(c)) {
                end += 1
            }
            if (1..=9).contains(&(end - indent))
                && s.get(end).is_some_and(|c| matches!(*c, 46 | 41))
            {
                marker = Some((end + 1, cat(&[&s[indent..end], &text(".")])))
            }
        }
        if let Some((mut end, glyph)) = marker {
            if s.get(end).is_some_and(|c| matches!(*c, 9 | 32)) {
                while s.get(end).is_some_and(|c| matches!(*c, 9 | 32)) {
                    end += 1
                }
                return vec![cat(&[
                    &vec![32; (indent / 2) * 2],
                    &paint(&glyph, "bullet", p),
                    &text(" "),
                    &inline(&s[end..], p),
                ])];
            }
        }
    }
    vec![inline(s, p)]
}
pub fn markdown_transition(
    s: &[u16],
    state: &MarkdownState,
    p: &Palette,
    partial: bool,
    starts_line: bool,
) -> (MarkdownState, Vec<Text>) {
    if partial && !starts_line {
        return (
            state.clone(),
            vec![if state.fence.is_some() {
                fence_line(s, p)
            } else {
                escape(s)
            }],
        );
    }
    let mut next = state.clone();
    let rows = line(s, &mut next, p);
    if partial {
        (state.clone(), vec![rows.concat()])
    } else {
        (next, rows)
    }
}
pub fn markdown(s: &[u16], p: &Palette) -> Vec<Text> {
    let mut state = MarkdownState::default();
    s.split(|&c| c == 10)
        .flat_map(|s| line(s, &mut state, p))
        .collect()
}
#[derive(Default)]
pub struct FrameOptions {
    pub width: i32,
    pub title: Text,
    pub right_title: Text,
    pub footer: Text,
    pub border: Vec<i32>,
}
#[derive(Clone)]
pub enum FrameRow {
    Text(Text),
    Divider,
}
fn flatten(s: &[u16]) -> Text {
    let mut out = vec![];
    let mut i = 0;
    while i < s.len() {
        if s[i] == 13 {
            out.push(32);
            if s.get(i + 1) == Some(&10) {
                i += 1
            }
        } else if s[i] == 10 {
            out.push(32)
        } else {
            out.push(s[i])
        }
        i += 1
    }
    out
}
fn plain_border(left: &str, right: &str, width: i32, b: &[i32]) -> Text {
    sgr(
        &text(&format!(
            "{left}{}{right}",
            "─".repeat((width - 2).max(0) as usize)
        )),
        b,
    )
}
fn label_border(
    left: &str,
    right: &str,
    label: &[u16],
    width: i32,
    b: &[i32],
    align_right: bool,
) -> Text {
    let fitted = truncate(label, width - 6);
    let len = display_width(&fitted);
    if len < 1 {
        return plain_border(left, right, width, b);
    }
    let rules = "─".repeat((width - len - 5).max(0) as usize);
    if align_right {
        cat(&[
            &sgr(&text(&format!("{left}{rules} ")), b),
            &fitted,
            &sgr(&text(&format!(" ─{right}")), b),
        ])
    } else {
        cat(&[
            &sgr(&text(&format!("{left}─ ")), b),
            &fitted,
            &sgr(&text(&format!(" {rules}{right}")), b),
        ])
    }
}
fn frame_top(o: &FrameOptions, w: i32) -> Text {
    let title = flatten(&o.title);
    let right = flatten(&o.right_title);
    let tw = display_width(&title);
    let rw = display_width(&right);
    if tw < 1 {
        return if rw < 1 {
            plain_border("╭", "╮", w, &o.border)
        } else {
            label_border("╭", "╮", &right, w, &o.border, true)
        };
    }
    if rw < 1 || tw > w - 6 {
        return label_border("╭", "╮", &title, w, &o.border, false);
    }
    let budget = w - 9 - tw;
    let fitted = truncate(&right, budget);
    let fw = display_width(&fitted);
    if budget < 1 || fw < 1 {
        return label_border("╭", "╮", &title, w, &o.border, false);
    }
    cat(&[
        &sgr(&text("╭─ "), &o.border),
        &title,
        &sgr(
            &text(&format!(
                " {} ",
                "─".repeat((w - tw - fw - 8).max(0) as usize)
            )),
            &o.border,
        ),
        &fitted,
        &sgr(&text(" ─╮"), &o.border),
    ])
}
pub fn frame(content: &[FrameRow], o: &FrameOptions) -> Vec<Text> {
    let w = o.width.max(5);
    let inner = w - 4;
    let mut out = vec![frame_top(o, w)];
    let empty = [FrameRow::Text(vec![])];
    for row in if content.is_empty() {
        &empty[..]
    } else {
        content
    } {
        match row {
            FrameRow::Divider => out.push(plain_border("├", "┤", w, &o.border)),
            FrameRow::Text(s) => {
                for r in wrap(s, inner) {
                    out.push(cat(&[
                        &sgr(&text("│"), &o.border),
                        &text(" "),
                        &fit(&r, inner),
                        &text(" "),
                        &sgr(&text("│"), &o.border),
                    ]))
                }
            }
        }
    }
    let footer = flatten(&o.footer);
    out.push(if display_width(&footer) < 1 {
        plain_border("╰", "╯", w, &o.border)
    } else {
        label_border("╰", "╯", &footer, w, &o.border, false)
    });
    out
}
pub fn box_rows(content: &[Text], o: &FrameOptions) -> Vec<Text> {
    let w = o.width.max(5);
    let inner = w - 4;
    let title = if o.title.is_empty() {
        vec![]
    } else {
        cat(&[
            &text(" "),
            &truncate(&o.title, (inner - 2).max(0)),
            &text(" "),
        ])
    };
    let top = cat(&[
        &text("╭─"),
        &title,
        &text(&"─".repeat((w - 3 - display_width(&title)).max(0) as usize)),
        &text("╮"),
    ]);
    let mut out = vec![sgr(&top, &o.border)];
    let empty = [vec![]];
    for s in if content.is_empty() {
        &empty[..]
    } else {
        content
    } {
        for r in wrap(s, inner) {
            out.push(cat(&[
                &sgr(&text("│"), &o.border),
                &text(" "),
                &fit(&r, inner),
                &text(" "),
                &sgr(&text("│"), &o.border),
            ]))
        }
    }
    out.push(plain_border("╰", "╯", w, &o.border));
    out
}
pub fn box_height(content: &[Text], width: i32) -> usize {
    2 + if content.is_empty() {
        1
    } else {
        content
            .iter()
            .map(|r| wrap(r, (width - 4).max(1)).len())
            .sum()
    }
}
pub fn frame_height(content: &[FrameRow], width: i32) -> usize {
    2 + if content.is_empty() {
        1
    } else {
        content
            .iter()
            .map(|r| match r {
                FrameRow::Divider => 1,
                FrameRow::Text(s) => wrap(s, width.max(5) - 4).len(),
            })
            .sum()
    }
}

pub mod protocol;
