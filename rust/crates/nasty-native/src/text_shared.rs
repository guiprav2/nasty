//! Text helpers shared by desktop nasty-native and the NastyOS guest
//! compositor (os/freestanding), so font matching and color parsing cannot
//! drift between the two. Pure glyphon/fontdb; no napi or windowing.

use glyphon::cosmic_text::{Align, Weight};
use glyphon::{Color as TextColor, Family};

/// CSS font matching within one family: the requested weight when the family has
/// it, else its nearest face (heavier first above 500, lighter first below 400).
/// cosmic-text only takes exact weights from a named family and otherwise falls
/// through to unrelated fonts, which then disagree with layout's measurements.
pub fn nearest_weight(db: &glyphon::fontdb::Database, family: Family<'_>, requested: u16) -> Weight {
    let Family::Name(name) = family else { return Weight(requested) };
    let weights: Vec<u16> = db.faces()
        .filter(|face| face.style == glyphon::fontdb::Style::Normal && face.families.iter().any(|(each, _)| each.eq_ignore_ascii_case(name)))
        .map(|face| face.weight.0)
        .collect();
    if weights.is_empty() || weights.contains(&requested) { return Weight(requested); }
    let pick = |candidates: &mut dyn Iterator<Item = u16>, heavier: bool| {
        if heavier { candidates.min() } else { candidates.max() }
    };
    let above = |weights: &[u16]| pick(&mut weights.iter().copied().filter(|weight| *weight > requested), true);
    let below = |weights: &[u16]| pick(&mut weights.iter().copied().filter(|weight| *weight < requested), false);
    let chosen = if requested > 500 { above(&weights).or_else(|| below(&weights)) }
        else if requested < 400 { below(&weights).or_else(|| above(&weights)) }
        else {
            // 400 tries 500 first and 500 tries 400 first, then lighter, then heavier.
            let partner = if requested == 400 { 500 } else { 400 };
            weights.contains(&partner).then_some(partner).or_else(|| below(&weights)).or_else(|| above(&weights))
        };
    Weight(chosen.unwrap_or(requested))
}

pub fn text_run_align(value: Option<&str>) -> Option<Align> {
    match value {
        Some("right") => Some(Align::Right),
        Some("center") => Some(Align::Center),
        Some("justify") => Some(Align::Justified),
        Some("end") => Some(Align::End),
        _ => None,
    }
}

pub fn generic_text_family(name: &str) -> Option<Family<'static>> {
    match name.to_ascii_lowercase().as_str() {
        "serif" | "ui-serif" | "fangsong" => Some(Family::Serif),
        "sans-serif" | "system-ui" | "ui-sans-serif" | "ui-rounded" => Some(Family::SansSerif),
        "monospace" | "ui-monospace" => Some(Family::Monospace),
        "cursive" => Some(Family::Cursive),
        "fantasy" => Some(Family::Fantasy),
        _ => None,
    }
}

/// Resolves a CSS font-family stack ("Fraunces, ui-serif, Georgia, serif") to
/// the first entry the font database can satisfy, like a browser's font
/// matching. Results are cached per stack until the database gains faces.
pub fn text_family<'a>(family: Option<&'a str>, db: &glyphon::fontdb::Database) -> Family<'a> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static RESOLVED: Mutex<Option<(usize, HashMap<String, Option<usize>>)>> = Mutex::new(None);
    let Some(stack) = family else {
        return Family::SansSerif;
    };
    let entries: Vec<&'a str> = stack
        .split(',')
        .map(|entry| entry.trim().trim_matches(|c| c == '\'' || c == '"').trim())
        .filter(|entry| !entry.is_empty())
        .collect();
    let face_count = db.len();
    let index = {
        let mut cache = RESOLVED.lock().expect("font family cache lock");
        if cache.as_ref().map_or(true, |(count, _)| *count != face_count) {
            *cache = Some((face_count, HashMap::new()));
        }
        let map = &mut cache.as_mut().unwrap().1;
        *map.entry(stack.to_owned()).or_insert_with(|| {
            entries.iter().position(|entry| {
                generic_text_family(entry).is_some()
                    || db.faces().any(|face| face.families.iter().any(|(name, _)| name.eq_ignore_ascii_case(entry)))
            })
        })
    };
    match index.map(|index| entries[index]) {
        Some(entry) => generic_text_family(entry).unwrap_or(Family::Name(entry)),
        None => Family::SansSerif,
    }
}

pub fn parse_text_color(value: &str) -> Option<TextColor> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }
    let red = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let green = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&hex[4..6], 16).ok()?;
    let alpha = if hex.len() == 8 {
        u8::from_str_radix(&hex[6..8], 16).ok()?
    } else {
        255
    };
    Some(TextColor::rgba(red, green, blue, alpha))
}
