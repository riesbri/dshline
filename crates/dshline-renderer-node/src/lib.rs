//! Node owns only the transport. Admission and transformations stay in the pure crate.
use napi::{JsString, bindgen_prelude::Utf16String};
use napi_derive::napi;

/// Execute one bounded UTF-16-code-unit JSON request and return a result envelope.
#[napi]
pub fn execute(request: JsString<'_>) -> String {
    let result = std::panic::catch_unwind(|| match request.utf8_len() {
        Ok(length) if length > 1_048_576 => dshline_renderer::protocol::error("RESOURCE_LIMIT"),
        Ok(_) => match request.into_utf8() {
            Ok(bytes) => dshline_renderer::protocol::execute_bytes(bytes.as_slice()),
            Err(_) => dshline_renderer::protocol::error("INVALID_INPUT"),
        },
        Err(_) => dshline_renderer::protocol::error("INVALID_INPUT"),
    });
    match result {
        Ok(value) => value.to_string(),
        Err(_) => dshline_renderer::protocol::error("BACKEND_FAILURE").to_string(),
    }
}

fn boundary_error(code: &str) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, code)
}

/// Measure bounded lossless UTF-16 directly, without JSON or code-unit arrays in JavaScript.
#[napi]
pub fn display_width(request: JsString<'_>) -> napi::Result<i32> {
    std::panic::catch_unwind(|| {
        let value = bounded_text(request)?;
        Ok(dshline_renderer::display_width(value.as_slice()))
    })
    .map_err(|_| boundary_error("BACKEND_FAILURE"))?
}

/// Look up one validated Unicode code point, including lone surrogate code-unit values.
#[napi]
pub fn code_point_width(code: f64) -> napi::Result<i32> {
    std::panic::catch_unwind(|| {
        if !code.is_finite() || code.fract() != 0.0 || !(0.0..=0x10ffff as f64).contains(&code) {
            return Err(boundary_error("INVALID_INPUT"));
        }
        Ok(dshline_renderer::code_point_width(code as u32))
    })
    .map_err(|_| boundary_error("BACKEND_FAILURE"))?
}

// These single-input transforms have bounded expansion at 2048 UTF-16 units;
// styled wrapping can replay at most the input's escapes on each output row.
const MAX_TEXT_UNITS: usize = 2048;
const MAX_COLUMNS: f64 = 256.0;
struct Input<'a> {
    value: napi::JsStringUtf16<'a>,
    length: usize,
}
impl Input<'_> {
    fn as_slice(&self) -> &[u16] {
        // napi-rs includes its C terminator in JsStringUtf16::as_slice(). The
        // measured JS length excludes that sentinel, not any real trailing NUL.
        &self.value.as_slice()[..self.length]
    }
}
fn bounded_text(request: JsString<'_>) -> napi::Result<Input<'_>> {
    let length = request.utf16_len()?;
    if length > MAX_TEXT_UNITS {
        return Err(boundary_error("RESOURCE_LIMIT"));
    }
    Ok(Input {
        value: request.into_utf16()?,
        length,
    })
}
fn columns(value: f64) -> napi::Result<i32> {
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > MAX_COLUMNS {
        return Err(boundary_error("INVALID_INPUT"));
    }
    Ok(value as i32)
}
fn guarded<T>(work: impl FnOnce() -> napi::Result<T> + std::panic::UnwindSafe) -> napi::Result<T> {
    std::panic::catch_unwind(work).map_err(|_| boundary_error("BACKEND_FAILURE"))?
}

/// Transform bounded UTF-16 directly, preserving unpaired surrogates.
#[napi]
pub fn strip_ansi(request: JsString<'_>) -> napi::Result<Utf16String> {
    guarded(|| {
        let source = bounded_text(request)?;
        Ok(dshline_renderer::strip_ansi(source.as_slice()).into())
    })
}

/// Transform bounded UTF-16 directly, preserving unpaired surrogates.
#[napi]
pub fn escape_controls(request: JsString<'_>) -> napi::Result<Utf16String> {
    guarded(|| {
        let source = bounded_text(request)?;
        Ok(dshline_renderer::escape(source.as_slice()).into())
    })
}

/// Transform bounded UTF-16 directly, preserving unpaired surrogates.
#[napi]
pub fn sanitize_pasted(request: JsString<'_>) -> napi::Result<Utf16String> {
    guarded(|| {
        let source = bounded_text(request)?;
        Ok(dshline_renderer::sanitize(source.as_slice()).into())
    })
}

/// Transform bounded UTF-16 and an integer column budget without JSON transport.
#[napi]
pub fn truncate_to_width(request: JsString<'_>, budget: f64) -> napi::Result<Utf16String> {
    guarded(|| {
        let budget = columns(budget)?;
        let source = bounded_text(request)?;
        Ok(dshline_renderer::truncate(source.as_slice(), budget).into())
    })
}

/// Transform bounded UTF-16 and an integer column budget without JSON transport.
#[napi]
pub fn tail_to_width(request: JsString<'_>, budget: f64) -> napi::Result<Utf16String> {
    guarded(|| {
        let budget = columns(budget)?;
        let source = bounded_text(request)?;
        Ok(dshline_renderer::tail(source.as_slice(), budget).into())
    })
}

/// Transform bounded UTF-16 and an integer column budget without JSON transport.
#[napi]
pub fn fit_to_width(request: JsString<'_>, budget: f64) -> napi::Result<Utf16String> {
    guarded(|| {
        let budget = columns(budget)?;
        let source = bounded_text(request)?;
        Ok(dshline_renderer::fit(source.as_slice(), budget).into())
    })
}

/// Transform bounded UTF-16 and an integer column budget without JSON transport.
#[napi]
pub fn chunk_to_width(request: JsString<'_>, budget: f64) -> napi::Result<Vec<Utf16String>> {
    guarded(|| {
        let budget = columns(budget)?;
        let source = bounded_text(request)?;
        Ok(dshline_renderer::chunk(source.as_slice(), budget)
            .into_iter()
            .map(Utf16String::from)
            .collect())
    })
}

/// Transform bounded UTF-16 and an integer column budget without JSON transport.
#[napi]
pub fn wrap_to_width(request: JsString<'_>, budget: f64) -> napi::Result<Vec<Utf16String>> {
    guarded(|| {
        let budget = columns(budget)?;
        let source = bounded_text(request)?;
        Ok(dshline_renderer::wrap(source.as_slice(), budget)
            .into_iter()
            .map(Utf16String::from)
            .collect())
    })
}
