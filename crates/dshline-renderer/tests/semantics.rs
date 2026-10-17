use dshline_renderer::*;
use serde_json::json;
#[test]
fn fit_reuses_measured_prefix_without_changing_original_padding() {
    let atoms = [text("a"), text(" "), text("中"), text("e\u{301}"), text("\x1b[31m"), text("\x1b[0m"), text("\x1b]unterminated"), vec![0xd800], vec![0xdc00], vec![0, 9, 27]];
    for length in [0, 1, 23, 64, 192, 512, 2048] {
        for offset in 0..atoms.len() {
            let mut source = Vec::new();
            let mut i = offset;
            while source.len() < length { source.extend_from_slice(&atoms[i % atoms.len()]); i += 1; }
            source.truncate(length);
            for budget in [-256, -1, 0, 1, 8, 40, 120, 256] {
                let mut original = if display_width(&source) > budget { truncate(&source, budget) } else { source.clone() };
                let pad = (budget - display_width(&original)).max(0) as usize;
                original.extend(std::iter::repeat_n(32, pad));
                assert_eq!(fit(&source, budget), original, "length {length}, offset {offset}, budget {budget}");
            }
        }
    }
    assert_eq!(fit(&text("\x1b[31m"), 0), text("\x1b[31m"));
    assert!(fit(&text("\x1b[31m"), -1).is_empty());
}
#[test]
fn unicode17_codepoint_sum_and_lone_units() {
    assert_eq!(display_width(&text("中e\u{301}👨\u{200d}👩")), 7);
    assert_eq!(code_point_width(0x1faea), 2);
    assert_eq!(truncate(&[0xd800, 97, 0xdc00], 2), vec![0xd800, 97]);
    assert_eq!(tail(&[0xd800, 97, 0xdc00], 1), vec![0xdc00]);
    assert_eq!(display_width(&[0xd800, 0xdc00]), 1);
}
#[test]
fn ansi_is_narrow_and_truncation_closes_only_open_escape() {
    assert_eq!(strip_ansi(&text("a\x1b[31mb\x1b[0m")), text("ab"));
    assert_eq!(strip_ansi(&text("\x1b[1:2mx")), text("\x1b[1:2mx"));
    assert_eq!(
        truncate(&text("\x1b[31ma\u{301}b"), 1),
        text("\x1b[31ma\u{301}\x1b[0m")
    );
    assert_eq!(truncate(&text("a\u{301}b"), 1), text("a\u{301}"));
    assert_eq!(
        truncate(&text("\x1b[ma\x1b[0mb"), 1),
        text("\x1b[ma\x1b[0m")
    );
    assert_eq!(strip_ansi(&text("a\x1b]url\x1b\\b")), text("ab"));
}
#[test]
fn wrap_replays_styles_not_combining_marks() {
    assert_eq!(
        wrap(&text("\x1b[31ma\u{301}b\x1b[0m"), 1),
        vec![text("\x1b[31ma\u{301}\x1b[0m"), text("\x1b[31mb\x1b[0m")]
    );
    assert_eq!(wrap(&text("中"), 1), vec![text("中")]);
    assert_eq!(chunk(&text("中"), 1), vec![text(""), text("中")]);
    assert_eq!(wrap(&text("a b c"), 3), vec![text("a"), text("b c")]);
    assert_eq!(tail(&text("a\u{301}b"), 1), text("b"));
}
#[test]
fn chunk_row_capacity_preserves_style_replay_zero_width_and_empty_rows() {
    assert_eq!(
        chunk(&text("\x1b[31ma\u{301}b\x1b[0m\n中"), 1),
        vec![text("\x1b[31ma\u{301}\x1b[0m"), text("\x1b[31mb\x1b[0m"), text(""), text("中")]
    );
    assert_eq!(chunk(&[0xd800, 97, 0xdc00], 1), vec![vec![0xd800], text("a"), vec![0xdc00]]);
    assert_eq!(chunk(&text("x"), i32::MAX), vec![text("x")]);
    assert_eq!(chunk(&text("\n"), 80), vec![text(""), text("")]);
}
#[test]
fn tab_columns_count_codepoints_not_cells() {
    assert_eq!(escape(&text("中\tX")), text("中       X"));
    assert_eq!(escape(&[0xd800, 9]), [vec![0xd800], vec![32; 7]].concat());
    assert_eq!(sanitize(&text("a\r\nb\rc\t\x1b")), text("a\nb\nc    ^["));
}
#[test]
fn split_joins_zwj_and_regional_indicators() {
    let s = text("a👨\u{200d}👩z");
    assert_eq!(
        split_columns(&s, 2, 3),
        [text("a"), text("👨\u{200d}👩"), text("z")]
    );
    assert_eq!(
        split_columns(&text("🇨🇳x"), 1, 2),
        [text(""), text("🇨🇳"), text("x")]
    );
}
#[test]
fn markdown_fence_transition_is_pure_and_partial_does_not_commit() {
    let p = Palette::default();
    let s = MarkdownState::default();
    let (next, rows) = markdown_transition(&text("````ts"), &s, &p, true, true);
    assert!(next.fence.is_none());
    assert_eq!(rows, vec![text("\x1b[90mts\x1b[0m")]);
    let (open, _) = markdown_transition(&text("````"), &s, &p, false, true);
    let (still, rows) = markdown_transition(&text("```"), &open, &p, false, true);
    assert_eq!(still.fence, open.fence);
    assert_eq!(rows, vec![text("  \x1b[36m```\x1b[0m")]);
    let (closed, rows) = markdown_transition(&text("````"), &open, &p, false, true);
    assert!(closed.fence.is_none());
    assert!(rows.is_empty());
    assert_eq!(
        markdown_transition(&text("**x**"), &s, &p, true, false).1,
        vec![text("**x**")]
    );
}
#[test]
fn markdown_dialect_and_palette_opaque_missing_roles() {
    let p = Palette::default();
    assert_eq!(
        strip_ansi(&inline(
            &text("__init__ snake_case **bold** ``code`` [x](url)"),
            &p
        )),
        text("__init__ snake_case bold code x (url)")
    );
    let p = Palette {
        id: text("not-domain"),
        depth: 24,
        roles: Default::default(),
    };
    assert_eq!(inline(&text("**x**"), &p), text("x"));
}
#[test]
fn borders_labels_and_wide_fitting() {
    let o = FrameOptions {
        width: 5,
        title: text("title"),
        border: vec![31],
        ..Default::default()
    };
    let rows = box_rows(&[text("中")], &o);
    assert_eq!(rows[0], text("\x1b[31m╭─  ╮\x1b[0m"));
    assert_eq!(display_width(&rows[1]), 5);
    assert!(!rows[1].contains(&0x4e2d));
    let o = FrameOptions {
        width: 16,
        title: text("L\nX"),
        right_title: text("R"),
        footer: text("F"),
        ..Default::default()
    };
    let rows = frame(&[FrameRow::Divider], &o);
    assert!(rows.iter().all(|r| display_width(r) == 16));
    assert_eq!(rows.len(), frame_height(&[FrameRow::Divider], 16));
}
#[test]
fn transport_rejects_untrusted_types_limits_and_extreme_numbers() {
    use protocol::execute;
    for v in [
        json!({"op":"displayWidth","text":"x"}),
        json!({"op":"displayWidth","text":[65536]}),
        json!({"op":"displayWidth","text":[],"unknown":true}),
        json!({"op":"wrapToWidth","text":[],"columns":i64::MIN}),
        json!({"op":"wrapToWidth","text":[],"columns":1e99}),
        json!({"op":"markdownTransition","text":[],"state":{"fence":[96]},"palette":{"id":[120],"depth":4,"roles":[]},"mode":"line","startsLine":true}),
    ] {
        assert_eq!(execute(&v)["ok"], false, "{v}")
    }
    assert_eq!(
        execute(&json!({"op":"displayWidth","text":vec![97;2049]}))["error"]["code"],
        "RESOURCE_LIMIT"
    );
    assert_eq!(
        protocol::execute_bytes(&vec![32; 1_048_577])["error"]["code"],
        "RESOURCE_LIMIT"
    );
    assert_eq!(
        execute(&json!({"op":"stripAnsi","text":[0xd800,27,91,109,0xdc00]}))["value"],
        json!([0xd800, 0xdc00])
    );
}
#[test]
fn malformed_scanner_smoke_never_loses_units_or_panics() {
    let mut rng = 42u64;
    for _ in 0..1000 {
        let mut s = vec![];
        for _ in 0..32 {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            s.push((rng >> 24) as u16)
        }
        for n in [-1, 0, 1, 4, 32] {
            let _ = truncate(&s, n);
            let _ = tail(&s, n);
            let _ = wrap(&s, n);
            let _ = chunk(&s, n);
        }
        let p = split_columns(&s, 1, 7);
        assert_eq!(p.concat(), s);
        let _ = inline(&s, &Palette::default());
    }
}

#[test]
fn palette_metadata_is_lossless_utf16_and_duplicate_keys_reject() {
    let mut v = json!({"op":"renderInline","text":[42,42,120,42,42],"palette":{"id":[55296],"depth":4,"roles":[[[55296],[31]],[[115,116,114,111,110,103],[1]]]}});
    assert_eq!(
        protocol::execute(&v)["value"],
        json!(text("\x1b[1mx\x1b[0m"))
    );
    v["palette"]["roles"] = json!([[[55296], [31]], [[55296], [32]]]);
    assert_eq!(protocol::execute(&v)["error"]["code"], "INVALID_INPUT");
}
