//! Bounded verification transport, not a Node binding or runtime selector.
use super::*;
use serde_json::{Value, json};
type R<T> = Result<T, &'static str>;
pub fn error(code: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"fallbackEligible":false}})
}
fn obj(v: &Value, required: &[&str], optional: &[&str]) -> R<()> {
    let m = v.as_object().ok_or("INVALID_INPUT")?;
    if required.iter().any(|k| !m.contains_key(*k))
        || m.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("INVALID_INPUT");
    }
    Ok(())
}
fn num(v: &Value, min: i64, max: i64) -> R<i32> {
    let n = v.as_i64().ok_or("INVALID_INPUT")?;
    if n < min || n > max {
        return Err("INVALID_INPUT");
    }
    Ok(n as i32)
}
fn txt(v: &Value) -> R<Text> {
    let a = v.as_array().ok_or("INVALID_INPUT")?;
    if a.len() > 2048 {
        return Err("RESOURCE_LIMIT");
    }
    a.iter()
        .map(|n| num(n, 0, 65535).map(|n| n as u16))
        .collect()
}
fn texts(v: &Value) -> R<Vec<Text>> {
    let a = v.as_array().ok_or("INVALID_INPUT")?;
    if a.len() > 64 {
        return Err("RESOURCE_LIMIT");
    }
    a.iter().map(txt).collect()
}
fn params(v: &Value) -> R<Vec<i32>> {
    let a = v.as_array().ok_or("INVALID_INPUT")?;
    if a.len() > 16 {
        return Err("RESOURCE_LIMIT");
    }
    a.iter().map(|n| num(n, -9999, 9999)).collect()
}
fn palette(v: &Value) -> R<Palette> {
    obj(v, &["id", "depth", "roles"], &[])?;
    let id = txt(&v["id"])?;
    let depth = num(&v["depth"], 0, 24)?;
    if ![0, 4, 8, 24].contains(&depth) {
        return Err("INVALID_INPUT");
    }
    let rs = v["roles"].as_array().ok_or("INVALID_INPUT")?;
    if rs.len() > 64 {
        return Err("RESOURCE_LIMIT");
    }
    let mut roles = BTreeMap::new();
    for pair in rs {
        let pair = pair.as_array().ok_or("INVALID_INPUT")?;
        if pair.len() != 2 {
            return Err("INVALID_INPUT");
        }
        let key = txt(&pair[0])?;
        let value = params(&pair[1])?;
        if roles.insert(key, value).is_some() {
            return Err("INVALID_INPUT");
        }
    }
    Ok(Palette { id, depth, roles })
}
fn rows(v: &Value) -> R<Vec<FrameRow>> {
    let a = v.as_array().ok_or("INVALID_INPUT")?;
    if a.len() > 64 {
        return Err("RESOURCE_LIMIT");
    }
    a.iter()
        .map(|r| {
            if r.is_array() {
                txt(r).map(FrameRow::Text)
            } else {
                obj(r, &["kind"], &[])?;
                if r["kind"] != "divider" {
                    return Err("INVALID_INPUT");
                }
                Ok(FrameRow::Divider)
            }
        })
        .collect()
}
fn options(v: &Value, frame: bool) -> R<FrameOptions> {
    obj(
        v,
        &["width"],
        if frame {
            &["title", "rightTitle", "footer", "border"]
        } else {
            &["title", "border"]
        },
    )?;
    Ok(FrameOptions {
        width: num(&v["width"], -256, 256)?,
        title: if v.get("title").is_some() {
            txt(&v["title"])?
        } else {
            vec![]
        },
        right_title: if v.get("rightTitle").is_some() {
            txt(&v["rightTitle"])?
        } else {
            vec![]
        },
        footer: if v.get("footer").is_some() {
            txt(&v["footer"])?
        } else {
            vec![]
        },
        border: if v.get("border").is_some() {
            params(&v["border"])?
        } else {
            vec![]
        },
    })
}
// Mirror normalized conservative admission, counting UTF-16 unit arrays as text,
// while parameter arrays remain collections. Checked before operation allocation.
fn estimate(
    v: &Value,
    key: Option<&str>,
    units: &mut usize,
    key_units: &mut usize,
    entries: &mut usize,
    width: &mut i64,
) {
    match v {
        Value::String(s) => *units += s.encode_utf16().count(),
        Value::Number(n) => {
            if key != Some("code") {
                *width = (*width).max(n.as_i64().unwrap_or(0).saturating_abs())
            }
        }
        Value::Array(a) => {
            if key == Some("roles") {
                for pair in a {
                    if let Some(pair) = pair.as_array() {
                        if pair.len() == 2 {
                            if let Some(k) = pair[0].as_array() {
                                *key_units += k.len();
                            }
                            estimate(&pair[1], None, units, key_units, entries, width)
                        }
                    }
                }
            } else if key.is_some_and(|k| {
                [
                    "id",
                    "text",
                    "mark",
                    "indent",
                    "title",
                    "rightTitle",
                    "footer",
                    "fence",
                    "content-row",
                ]
                .contains(&k)
            }) {
                *units += a.len()
            } else {
                *entries += a.len();
                for c in a {
                    estimate(
                        c,
                        if key == Some("content") && c.is_array() {
                            Some("content-row")
                        } else {
                            None
                        },
                        units,
                        key_units,
                        entries,
                        width,
                    )
                }
            }
        }
        Value::Object(m) => {
            for (k, c) in m {
                *key_units += k.encode_utf16().count();
                estimate(c, Some(k), units, key_units, entries, width)
            }
        }
        _ => (),
    }
}
fn admission(v: &Value) -> R<()> {
    let (mut u, mut k, mut e, mut w) = (0, 0, 0, 0);
    estimate(v, None, &mut u, &mut k, &mut e, &mut w);
    let base = u + w.min(256) as usize + e + 1;
    if u + k > 8192
        || base
            .checked_mul(base)
            .and_then(|v| v.checked_mul(1024))
            .is_none_or(|n| n > 67_108_864)
    {
        return Err("RESOURCE_LIMIT");
    }
    Ok(())
}
pub fn execute_bytes(bytes: &[u8]) -> Value {
    if bytes.len() > 1_048_576 {
        return error("RESOURCE_LIMIT");
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(v) => execute(&v),
        Err(_) => error("INVALID_INPUT"),
    }
}
pub fn execute(v: &Value) -> Value {
    match run(v) {
        Ok(value) => {
            let mut u = 0;
            fn count(v: &Value, u: &mut usize) {
                match v {
                    Value::Array(a) => {
                        *u += a.len();
                        for c in a {
                            if !c.is_number() {
                                count(c, u)
                            }
                        }
                    }
                    Value::Object(m) => {
                        for c in m.values() {
                            count(c, u)
                        }
                    }
                    _ => (),
                }
            }
            count(&value, &mut u);
            if u > 67_108_864 {
                error("RESOURCE_LIMIT")
            } else {
                json!({"ok":true,"value":value})
            }
        }
        Err(code) => error(code),
    }
}
fn run(v: &Value) -> R<Value> {
    let (mut units, mut keys, mut entries, mut width) = (0, 0, 0, 0);
    estimate(v, None, &mut units, &mut keys, &mut entries, &mut width);
    if units + keys > 8192 {
        return Err("RESOURCE_LIMIT");
    }

    let mut admitted = v.clone();
    if v["op"] != "markdownTransition" {
        if let Some(m) = admitted.as_object_mut() {
            m.remove("palette");
        }
    } else if let Some(m) = admitted.as_object_mut() {
        m.remove("op");
    }
    admission(&admitted)?;
    let op = v["op"].as_str().ok_or("INVALID_INPUT")?;
    let p = if v.get("palette").is_some() {
        palette(&v["palette"])?
    } else {
        Palette::default()
    };
    let simple = [
        "displayWidth",
        "stripAnsi",
        "escapeControls",
        "sanitizePasted",
        "renderInline",
        "renderMarkdown",
    ];
    let cuts = [
        "truncateToWidth",
        "tailToWidth",
        "chunkToWidth",
        "wrapToWidth",
        "fitToWidth",
    ];
    if simple.contains(&op) {
        obj(v, &["op", "text"], &["palette"])?;
        let s = txt(&v["text"])?;
        return Ok(match op {
            "displayWidth" => json!(display_width(&s)),
            "stripAnsi" => json!(strip_ansi(&s)),
            "escapeControls" => json!(escape(&s)),
            "sanitizePasted" => json!(sanitize(&s)),
            "renderInline" => json!(inline(&s, &p)),
            _ => json!(markdown(&s, &p)),
        });
    }
    if cuts.contains(&op) {
        obj(v, &["op", "text", "columns"], &["palette"])?;
        let s = txt(&v["text"])?;
        let n = num(&v["columns"], -256, 256)?;
        return Ok(match op {
            "truncateToWidth" => json!(truncate(&s, n)),
            "tailToWidth" => json!(tail(&s, n)),
            "chunkToWidth" => json!(chunk(&s, n)),
            "wrapToWidth" => json!(wrap(&s, n)),
            _ => json!(fit(&s, n)),
        });
    }
    match op {
        "codePointWidth" => {
            obj(v, &["op", "code"], &["palette"])?;
            Ok(json!(
                code_point_width(num(&v["code"], 0, 0x10ffff)? as u32)
            ))
        }
        "sgr" => {
            obj(v, &["op", "text", "params"], &["palette"])?;
            Ok(json!(sgr(&txt(&v["text"])?, &params(&v["params"])?)))
        }
        "hangingIndent" => {
            obj(
                v,
                &["op", "text", "mark", "indent", "columns"],
                &["palette"],
            )?;
            Ok(json!(hanging(
                &txt(&v["mark"])?,
                &txt(&v["indent"])?,
                &txt(&v["text"])?,
                num(&v["columns"], -256, 256)?
            )))
        }
        "box" => {
            obj(v, &["op", "content", "options"], &["palette"])?;
            Ok(json!(box_rows(
                &texts(&v["content"])?,
                &options(&v["options"], false)?
            )))
        }
        "frame" => {
            obj(v, &["op", "content", "options"], &["palette"])?;
            Ok(json!(frame(
                &rows(&v["content"])?,
                &options(&v["options"], true)?
            )))
        }
        "boxHeight" => {
            obj(v, &["op", "content", "width"], &["palette"])?;
            Ok(json!(box_height(
                &texts(&v["content"])?,
                num(&v["width"], -256, 256)?
            )))
        }
        "frameHeight" => {
            obj(v, &["op", "content", "width"], &["palette"])?;
            Ok(json!(frame_height(
                &rows(&v["content"])?,
                num(&v["width"], -256, 256)?
            )))
        }
        "splitAtColumns" => {
            obj(v, &["op", "text", "from", "to"], &["palette"])?;
            Ok(json!(split_columns(
                &txt(&v["text"])?,
                num(&v["from"], -256, 256)?,
                num(&v["to"], -256, 256)?
            )))
        }
        "markdownTransition" => {
            obj(
                v,
                &["op", "text", "state", "palette", "mode", "startsLine"],
                &[],
            )?;
            obj(&v["state"], &["fence"], &[])?;
            let fence = if v["state"]["fence"].is_null() {
                None
            } else {
                let f = txt(&v["state"]["fence"])?;
                if f.len() < 3 || !matches!(f[0], 96 | 126) || !f.iter().all(|&c| c == f[0]) {
                    return Err("INVALID_INPUT");
                }
                Some(f)
            };
            let mode = v["mode"].as_str().ok_or("INVALID_INPUT")?;
            if !["line", "partial"].contains(&mode) {
                return Err("INVALID_INPUT");
            }
            let starts = v["startsLine"].as_bool().ok_or("INVALID_INPUT")?;
            let (state, rows) = markdown_transition(
                &txt(&v["text"])?,
                &MarkdownState { fence },
                &p,
                mode == "partial",
                starts,
            );
            if rows.len() > 64 || rows.iter().any(|row| row.len() > 2048) {
                return Err("RESOURCE_LIMIT");
            }
            Ok(json!({"state":{"fence":state.fence},"rows":rows}))
        }
        _ => Err("INVALID_INPUT"),
    }
}
