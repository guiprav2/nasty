//! CSS-to-Taffy layout style conversion shared by desktop nasty-native and
//! the NastyOS guest kernel, so both lay out documents identically.
//! Desktop compiles it with `nasty_napi` (napi object); the guest reads the
//! same camelCase objects through serde.

use taffy::prelude::*;

/// Layout errors (desktop converts them into napi errors).
#[derive(Debug)]
pub struct LayoutError(pub String);

impl std::fmt::Display for LayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, LayoutError>;

// Same call shape as napi's `Error::new(Status::…, msg)`.
#[allow(dead_code)]
pub enum Status {
    InvalidArg,
    GenericFailure,
}
pub struct Error;
impl Error {
    #[allow(clippy::new_ret_no_self)]
    pub fn new(_status: Status, message: impl Into<String>) -> LayoutError {
        LayoutError(message.into())
    }
}

#[cfg_attr(nasty_napi, napi_derive::napi(object))]
#[cfg_attr(not(nasty_napi), derive(serde::Deserialize))]
#[cfg_attr(not(nasty_napi), serde(rename_all = "camelCase", default))]
#[derive(Default)]
pub struct LayoutStyle {
    pub display: Option<String>,
    pub position: Option<String>,
    pub top: Option<f64>,
    pub right: Option<f64>,
    pub bottom: Option<f64>,
    pub left: Option<f64>,
    pub top_percent: Option<f64>,
    pub right_percent: Option<f64>,
    pub bottom_percent: Option<f64>,
    pub left_percent: Option<f64>,
    pub direction: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub width_percent: Option<f64>,
    pub height_percent: Option<f64>,
    pub aspect_ratio: Option<f64>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_width: Option<f64>,
    pub max_height: Option<f64>,
    pub min_width_percent: Option<f64>,
    pub min_height_percent: Option<f64>,
    pub max_width_percent: Option<f64>,
    pub max_height_percent: Option<f64>,
    pub flex_wrap: Option<String>,
    pub padding: Option<f64>,
    pub padding_top: Option<f64>,
    pub padding_right: Option<f64>,
    pub padding_bottom: Option<f64>,
    pub padding_left: Option<f64>,
    pub margin: Option<f64>,
    pub margin_top: Option<f64>,
    pub margin_right: Option<f64>,
    pub margin_bottom: Option<f64>,
    pub margin_left: Option<f64>,
    pub margin_top_auto: Option<bool>,
    pub margin_right_auto: Option<bool>,
    pub margin_bottom_auto: Option<bool>,
    pub margin_left_auto: Option<bool>,
    pub border_width: Option<f64>,
    pub border_top_width: Option<f64>,
    pub border_right_width: Option<f64>,
    pub border_bottom_width: Option<f64>,
    pub border_left_width: Option<f64>,
    pub gap: Option<f64>,
    pub flex_grow: Option<f64>,
    pub flex_shrink: Option<f64>,
    pub flex_basis: Option<f64>,
    pub flex_basis_percent: Option<f64>,
    pub align_items: Option<String>,
    pub justify_content: Option<String>,
    /// CSS `grid-template-columns` track list, e.g. `repeat(3, minmax(0px, 1fr))`.
    pub grid_template_columns: Option<String>,
    /// CSS `grid-template-rows` track list.
    pub grid_template_rows: Option<String>,
    pub grid_auto_flow: Option<String>,
    pub grid_auto_columns: Option<String>,
    pub grid_auto_rows: Option<String>,
    pub grid_column: Option<String>,
    pub grid_row: Option<String>,
    pub row_gap: Option<f64>,
    pub column_gap: Option<f64>,
}

/// One file-type choice in the file picker, e.g. "Images" with ["png", "jpg"].

pub fn finite_nonnegative(value: f64, name: &str) -> Result<f32> {
    if !value.is_finite() || value < 0.0 || value > f32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{name} must be a finite nonnegative number"),
        ));
    }
    Ok(value as f32)
}

pub fn finite_signed(value: f64, name: &str) -> Result<f32> {
    if !value.is_finite() || value.abs() > f32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{name} must be finite and within the supported numeric range"),
        ));
    }
    Ok(value as f32)
}


pub fn parse_css_length_px(s: &str) -> Result<f32> {
    let s = s.trim();
    if let Some(px) = s.strip_suffix("px") {
        let n: f64 = px.trim().parse().map_err(|_| {
            Error::new(Status::InvalidArg, format!("invalid length: {s}"))
        })?;
        return finite_nonnegative(n, "length");
    }
    if let Some(pct) = s.strip_suffix('%') {
        let n: f64 = pct.trim().parse().map_err(|_| {
            Error::new(Status::InvalidArg, format!("invalid percent length: {s}"))
        })?;
        // Percent tracks are resolved by Taffy against the grid container; store as length 0
        // is wrong. Prefer explicit px for bridge simplicity — reject bare %.
        let _ = n;
        return Err(Error::new(
            Status::InvalidArg,
            format!("percent track sizes are not supported yet: {s}"),
        ));
    }
    let n: f64 = s.parse().map_err(|_| {
        Error::new(Status::InvalidArg, format!("invalid length: {s}"))
    })?;
    finite_nonnegative(n, "length")
}

pub fn split_top_level_comma(s: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => return Some((&s[..i], &s[i + 1..])),
            _ => {}
        }
    }
    None
}

pub fn split_top_level_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ' ' | '\t' | '\n' | '\r' if depth == 0 => {
                if i > start {
                    let piece = s[start..i].trim();
                    if !piece.is_empty() {
                        out.push(piece.to_string());
                    }
                }
                start = i + ch.len_utf8();
            }
            _ => {}
        }
    }
    if start < s.len() {
        let tail = s[start..].trim();
        if !tail.is_empty() {
            out.push(tail.to_string());
        }
    }
    out
}

pub fn parse_min_track_sizing(s: &str) -> Result<MinTrackSizingFunction> {
    let s = s.trim();
    if s == "auto" {
        return Ok(MinTrackSizingFunction::auto());
    }
    if s == "min-content" {
        return Ok(MinTrackSizingFunction::min_content());
    }
    if s == "max-content" {
        return Ok(MinTrackSizingFunction::max_content());
    }
    if s.ends_with("fr") {
        return Ok(MinTrackSizingFunction::auto());
    }
    let len = parse_css_length_px(s)?;
    Ok(MinTrackSizingFunction::from(LengthPercentage::length(len)))
}

pub fn parse_max_track_sizing(s: &str) -> Result<MaxTrackSizingFunction> {
    let s = s.trim();
    if s == "auto" {
        return Ok(MaxTrackSizingFunction::auto());
    }
    if s == "min-content" {
        return Ok(MaxTrackSizingFunction::min_content());
    }
    if s == "max-content" {
        return Ok(MaxTrackSizingFunction::max_content());
    }
    if let Some(fr) = s.strip_suffix("fr") {
        let n: f32 = fr.trim().parse().map_err(|_| {
            Error::new(Status::InvalidArg, format!("invalid fr max track: {s}"))
        })?;
        if !n.is_finite() || n < 0.0 {
            return Err(Error::new(Status::InvalidArg, format!("invalid fr max track: {s}")));
        }
        return Ok(MaxTrackSizingFunction::fr(n));
    }
    let len = parse_css_length_px(s)?;
    Ok(MaxTrackSizingFunction::from(LengthPercentage::length(len)))
}

pub fn parse_track_sizing_function(raw: &str) -> Result<TrackSizingFunction> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(Error::new(Status::InvalidArg, "empty grid track"));
    }
    if let Some(inner) = s.strip_prefix("minmax(").and_then(|rest| rest.strip_suffix(')')) {
        let (min_raw, max_raw) = split_top_level_comma(inner).ok_or_else(|| {
            Error::new(Status::InvalidArg, format!("invalid minmax track: {s}"))
        })?;
        let min = parse_min_track_sizing(min_raw.trim())?;
        let max = parse_max_track_sizing(max_raw.trim())?;
        return Ok(minmax(min, max));
    }
    if s == "auto" {
        return Ok(TrackSizingFunction::AUTO);
    }
    if s == "min-content" {
        return Ok(TrackSizingFunction::MIN_CONTENT);
    }
    if s == "max-content" {
        return Ok(TrackSizingFunction::MAX_CONTENT);
    }
    if let Some(fr) = s.strip_suffix("fr") {
        let n: f32 = fr.trim().parse().map_err(|_| {
            Error::new(Status::InvalidArg, format!("invalid fr track: {s}"))
        })?;
        if !n.is_finite() || n < 0.0 {
            return Err(Error::new(Status::InvalidArg, format!("invalid fr track: {s}")));
        }
        return Ok(flex(n));
    }
    let len = parse_css_length_px(s)?;
    Ok(TrackSizingFunction::from(LengthPercentage::length(len)))
}

pub fn parse_grid_template_tracks(raw: &str) -> Result<Vec<GridTemplateComponent<String>>> {
    let tokens = split_top_level_tokens(raw.trim());
    let mut tracks = Vec::new();
    for token in tokens {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(inner) = t.strip_prefix("repeat(").and_then(|rest| rest.strip_suffix(')')) {
            let (count_raw, list_raw) = split_top_level_comma(inner).ok_or_else(|| {
                Error::new(Status::InvalidArg, format!("invalid repeat(): {t}"))
            })?;
            let count_raw = count_raw.trim();
            let mut repeated = Vec::new();
            for part in split_top_level_tokens(list_raw.trim()) {
                if part.trim().is_empty() {
                    continue;
                }
                repeated.push(parse_track_sizing_function(&part)?);
            }
            if count_raw == "auto-fill" {
                tracks.push(repeat(RepetitionCount::AutoFill, repeated));
            } else if count_raw == "auto-fit" {
                tracks.push(repeat(RepetitionCount::AutoFit, repeated));
            } else {
                let count: u16 = count_raw.parse().map_err(|_| {
                    Error::new(Status::InvalidArg, format!("invalid repeat count: {count_raw}"))
                })?;
                tracks.push(repeat(count, repeated));
            }
        } else {
            let sizing = parse_track_sizing_function(t)?;
            tracks.push(GridTemplateComponent::Single(sizing));
        }
    }
    Ok(tracks)
}

pub fn parse_grid_auto_tracks(raw: &str) -> Result<Vec<TrackSizingFunction>> {
    let mut tracks = Vec::new();
    for token in split_top_level_tokens(raw.trim()) {
        if token.trim().is_empty() {
            continue;
        }
        tracks.push(parse_track_sizing_function(&token)?);
    }
    Ok(tracks)
}

pub fn parse_grid_placement_line(raw: &str) -> Result<Line<GridPlacement>> {
    let s = raw.trim();
    if s == "auto" {
        return Ok(Line {
            start: GridPlacement::Auto,
            end: GridPlacement::Auto,
        });
    }
    let parts: Vec<&str> = s.split('/').map(|p| p.trim()).collect();
    let parse_one = |part: &str| -> Result<GridPlacement> {
        let part = part.trim();
        if part == "auto" || part.is_empty() {
            return Ok(GridPlacement::Auto);
        }
        if let Some(n) = part.strip_prefix("span ") {
            let n: u16 = n.trim().parse().map_err(|_| {
                Error::new(Status::InvalidArg, format!("invalid grid span: {part}"))
            })?;
            return Ok(span(n));
        }
        let n: i16 = part.parse().map_err(|_| {
            Error::new(Status::InvalidArg, format!("invalid grid line: {part}"))
        })?;
        Ok(line(n))
    };
    if parts.len() == 1 {
        Ok(Line {
            start: parse_one(parts[0])?,
            end: GridPlacement::Auto,
        })
    } else if parts.len() == 2 {
        Ok(Line {
            start: parse_one(parts[0])?,
            end: parse_one(parts[1])?,
        })
    } else {
        Err(Error::new(
            Status::InvalidArg,
            format!("invalid grid placement: {raw}"),
        ))
    }
}

pub fn convert_style(input: LayoutStyle) -> Result<Style> {
    let mut style = Style::default();
    // Nasty uses reset-style border-box sizing. There is no public boxSizing option.
    style.box_sizing = BoxSizing::BorderBox;
    if let Some(ratio) = input.aspect_ratio {
        if !ratio.is_finite() || ratio <= 0.0 || ratio > f32::MAX as f64 {
            return Err(Error::new(Status::InvalidArg, "aspectRatio must be finite and positive"));
        }
        style.aspect_ratio = Some(ratio as f32);
    }
    if let Some(position) = input.position.as_deref() {
        style.position = match position {
            "static" | "relative" => Position::Relative,
            "absolute" | "fixed" => Position::Absolute,
            _ => return Err(Error::new(Status::InvalidArg, format!("unknown position: {position}"))),
        };
    }
    for (name, value, target) in [
        ("top", input.top, &mut style.inset.top),
        ("right", input.right, &mut style.inset.right),
        ("bottom", input.bottom, &mut style.inset.bottom),
        ("left", input.left, &mut style.inset.left),
    ] {
        if let Some(value) = value {
            *target = LengthPercentageAuto::length(finite_signed(value, name)?);
        }
    }
    for (name, value, target) in [
        ("topPercent", input.top_percent, &mut style.inset.top),
        ("rightPercent", input.right_percent, &mut style.inset.right),
        ("bottomPercent", input.bottom_percent, &mut style.inset.bottom),
        ("leftPercent", input.left_percent, &mut style.inset.left),
    ] {
        if let Some(value) = value {
            *target = LengthPercentageAuto::percent(finite_signed(value, name)?);
        }
    }
    if let Some(display) = input.display.as_deref() {
        style.display = match display {
            "block" => Display::Block,
            "flex" => Display::Flex,
            "grid" => Display::Grid,
            "none" => Display::None,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("unknown display: {display}"),
                ))
            }
        };
    }
    if let Some(direction) = input.direction.as_deref() {
        style.flex_direction = match direction {
            "row" => FlexDirection::Row,
            "column" => FlexDirection::Column,
            "row-reverse" => FlexDirection::RowReverse,
            "column-reverse" => FlexDirection::ColumnReverse,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("unknown flex direction: {direction}"),
                ))
            }
        };
    }
    for (name, px, percent, target) in [
        (
            "width",
            input.width,
            input.width_percent,
            &mut style.size.width,
        ),
        (
            "height",
            input.height,
            input.height_percent,
            &mut style.size.height,
        ),
    ] {
        if px.is_some() && percent.is_some() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("{name} cannot be both pixels and percent"),
            ));
        }
        if let Some(px) = px {
            *target = Dimension::length(finite_nonnegative(px, name)?);
        }
        if let Some(percent) = percent {
            *target = Dimension::percent(finite_nonnegative(percent, name)?);
        }
    }
    for (name, px, percent, target) in [
        ("minWidth", input.min_width, input.min_width_percent, &mut style.min_size.width),
        ("minHeight", input.min_height, input.min_height_percent, &mut style.min_size.height),
        ("maxWidth", input.max_width, input.max_width_percent, &mut style.max_size.width),
        ("maxHeight", input.max_height, input.max_height_percent, &mut style.max_size.height),
    ] {
        if px.is_some() && percent.is_some() {
            return Err(Error::new(Status::InvalidArg, format!("{name} cannot be both pixels and percent")));
        }
        if let Some(value) = px {
            *target = LengthPercentageAuto::length(finite_nonnegative(value, name)?);
        }
        if let Some(value) = percent {
            *target = LengthPercentageAuto::percent(finite_nonnegative(value, name)?);
        }
    }
    style.flex_wrap = match input.flex_wrap.as_deref() {
        Some("wrap") => FlexWrap::Wrap,
        Some("wrap-reverse") => FlexWrap::WrapReverse,
        _ => FlexWrap::NoWrap,
    };
    let padding = input.padding.unwrap_or(0.0);
    style.padding = Rect {
        top: LengthPercentage::length(finite_nonnegative(
            input.padding_top.unwrap_or(padding),
            "paddingTop",
        )?),
        right: LengthPercentage::length(finite_nonnegative(
            input.padding_right.unwrap_or(padding),
            "paddingRight",
        )?),
        bottom: LengthPercentage::length(finite_nonnegative(
            input.padding_bottom.unwrap_or(padding),
            "paddingBottom",
        )?),
        left: LengthPercentage::length(finite_nonnegative(
            input.padding_left.unwrap_or(padding),
            "paddingLeft",
        )?),
    };
    let margin = input.margin.unwrap_or(0.0);
    let margin_edge =
        |value: Option<f64>, auto: Option<bool>, name: &str| -> Result<LengthPercentageAuto> {
            if auto.unwrap_or(false) {
                Ok(LengthPercentageAuto::auto())
            } else {
                Ok(LengthPercentageAuto::length(finite_signed(
                    value.unwrap_or(margin),
                    name,
                )?))
            }
        };
    style.margin = Rect {
        top: margin_edge(input.margin_top, input.margin_top_auto, "marginTop")?,
        right: margin_edge(input.margin_right, input.margin_right_auto, "marginRight")?,
        bottom: margin_edge(
            input.margin_bottom,
            input.margin_bottom_auto,
            "marginBottom",
        )?,
        left: margin_edge(input.margin_left, input.margin_left_auto, "marginLeft")?,
    };
    let border = input.border_width.unwrap_or(0.0);
    style.border = Rect {
        top: LengthPercentage::length(finite_nonnegative(
            input.border_top_width.unwrap_or(border),
            "borderTopWidth",
        )?),
        right: LengthPercentage::length(finite_nonnegative(
            input.border_right_width.unwrap_or(border),
            "borderRightWidth",
        )?),
        bottom: LengthPercentage::length(finite_nonnegative(
            input.border_bottom_width.unwrap_or(border),
            "borderBottomWidth",
        )?),
        left: LengthPercentage::length(finite_nonnegative(
            input.border_left_width.unwrap_or(border),
            "borderLeftWidth",
        )?),
    };
    if let Some(value) = input.gap {
        let value = LengthPercentage::length(finite_nonnegative(value, "gap")?);
        style.gap = Size {
            width: value,
            height: value,
        };
    }
    if let Some(value) = input.row_gap {
        style.gap.height = LengthPercentage::length(finite_nonnegative(value, "rowGap")?);
    }
    if let Some(value) = input.column_gap {
        style.gap.width = LengthPercentage::length(finite_nonnegative(value, "columnGap")?);
    }
    if let Some(ref raw) = input.grid_template_columns {
        style.grid_template_columns = parse_grid_template_tracks(raw)?;
    }
    if let Some(ref raw) = input.grid_template_rows {
        style.grid_template_rows = parse_grid_template_tracks(raw)?;
    }
    if let Some(ref raw) = input.grid_auto_columns {
        style.grid_auto_columns = parse_grid_auto_tracks(raw)?;
    }
    if let Some(ref raw) = input.grid_auto_rows {
        style.grid_auto_rows = parse_grid_auto_tracks(raw)?;
    }
    if let Some(value) = input.grid_auto_flow.as_deref() {
        style.grid_auto_flow = match value {
            "row" => GridAutoFlow::Row,
            "column" => GridAutoFlow::Column,
            "row dense" | "dense" => GridAutoFlow::RowDense,
            "column dense" => GridAutoFlow::ColumnDense,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("unknown gridAutoFlow: {value}"),
                ))
            }
        };
    }
    if let Some(ref raw) = input.grid_column {
        style.grid_column = parse_grid_placement_line(raw)?;
    }
    if let Some(ref raw) = input.grid_row {
        style.grid_row = parse_grid_placement_line(raw)?;
    }
    if let Some(value) = input.flex_grow {
        style.flex_grow = finite_nonnegative(value, "flexGrow")?;
    }
    if let Some(value) = input.flex_shrink {
        style.flex_shrink = finite_nonnegative(value, "flexShrink")?;
    }
    if input.flex_basis.is_some() && input.flex_basis_percent.is_some() {
        return Err(Error::new(
            Status::InvalidArg,
            "flexBasis cannot be both pixels and percent",
        ));
    }
    if let Some(value) = input.flex_basis {
        style.flex_basis = Dimension::length(finite_nonnegative(value, "flexBasis")?);
    }
    if let Some(value) = input.flex_basis_percent {
        style.flex_basis = Dimension::percent(finite_nonnegative(value, "flexBasisPercent")?);
    }
    if let Some(value) = input.align_items.as_deref() {
        style.align_items = Some(match value {
            "start" | "flex-start" => AlignItems::START,
            "end" | "flex-end" => AlignItems::END,
            "center" | "unsafe center" => AlignItems::CENTER,
            "safe center" => AlignItems::SAFE_CENTER,
            "stretch" => AlignItems::STRETCH,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("unknown alignItems: {value}"),
                ))
            }
        });
    }
    if let Some(value) = input.justify_content.as_deref() {
        style.justify_content = Some(match value {
            "start" | "flex-start" => JustifyContent::START,
            "end" | "flex-end" => JustifyContent::END,
            "center" | "unsafe center" => JustifyContent::CENTER,
            "safe center" => JustifyContent::SAFE_CENTER,
            "space-between" => JustifyContent::SPACE_BETWEEN,
            "space-around" => JustifyContent::SPACE_AROUND,
            "space-evenly" => JustifyContent::SPACE_EVENLY,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("unknown justifyContent: {value}"),
                ))
            }
        });
    }
    Ok(style)
}

