//! Small Node binding for Taffy. The document and frame clock live in JavaScript.

use glyphon::cosmic_text::{Weight, Wrap};
use glyphon::{
    Attrs, Buffer as TextBuffer, Cache as TextCache, Color as TextColor, Edit, Editor, Family,
    FontSystem, Metrics, Resolution, Shaping, SwashCache, TextArea, TextAtlas, TextBounds,
    TextRenderer, Viewport,
};
use napi::bindgen_prelude::{Buffer, Either, Function};
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
#[cfg(target_os = "android")]
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use taffy::prelude::*;
use taffy::tree::TaffyError;
use wgpu::util::DeviceExt;

#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "ffmpeg_decode.rs"]
mod ffmpeg_decode;
#[cfg(target_os = "linux")]
mod audio_output;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent as OsWindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::ModifiersState;
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
use winit::window::{CursorIcon, ResizeDirection, Window as OsWindow, WindowId};

#[napi(object)]
#[derive(Default)]
pub struct LayoutStyle {
    pub display: Option<String>,
    pub position: Option<String>,
    pub top: Option<f64>,
    pub right: Option<f64>,
    pub bottom: Option<f64>,
    pub left: Option<f64>,
    pub direction: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub width_percent: Option<f64>,
    pub height_percent: Option<f64>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_width: Option<f64>,
    pub max_height: Option<f64>,
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
    pub align_items: Option<String>,
    pub justify_content: Option<String>,
}

#[napi(object)]
pub struct LayoutBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub margin_top: f64,
    pub margin_right: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub border_top: f64,
    pub border_right: f64,
    pub border_bottom: f64,
    pub border_left: f64,
    pub padding_top: f64,
    pub padding_right: f64,
    pub padding_bottom: f64,
    pub padding_left: f64,
}

fn finite_nonnegative(value: f64, name: &str) -> Result<f32> {
    if !value.is_finite() || value < 0.0 || value > f32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{name} must be a finite nonnegative number"),
        ));
    }
    Ok(value as f32)
}

fn finite_signed(value: f64, name: &str) -> Result<f32> {
    if !value.is_finite() || value.abs() > f32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{name} must be finite and within the supported numeric range"),
        ));
    }
    Ok(value as f32)
}

fn convert_style(input: LayoutStyle) -> Result<Style> {
    let mut style = Style::default();
    // Nasty uses reset-style border-box sizing. There is no public boxSizing option.
    style.box_sizing = BoxSizing::BorderBox;
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
    if let Some(display) = input.display.as_deref() {
        style.display = match display {
            "block" => Display::Block,
            "flex" => Display::Flex,
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
    if let Some(value) = input.min_width {
        style.min_size.width = LengthPercentageAuto::length(finite_nonnegative(value, "minWidth")?);
    }
    if let Some(value) = input.min_height {
        style.min_size.height =
            LengthPercentageAuto::length(finite_nonnegative(value, "minHeight")?);
    }
    if let Some(value) = input.max_width {
        style.max_size.width = LengthPercentageAuto::length(finite_nonnegative(value, "maxWidth")?);
    }
    if let Some(value) = input.max_height {
        style.max_size.height = LengthPercentageAuto::length(finite_nonnegative(value, "maxHeight")?);
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
    if let Some(value) = input.flex_grow {
        style.flex_grow = finite_nonnegative(value, "flexGrow")?;
    }
    if let Some(value) = input.flex_shrink {
        style.flex_shrink = finite_nonnegative(value, "flexShrink")?;
    }
    if let Some(value) = input.align_items.as_deref() {
        style.align_items = Some(match value {
            "start" | "flex-start" => AlignItems::START,
            "end" | "flex-end" => AlignItems::END,
            "center" => AlignItems::CENTER,
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
            "center" => JustifyContent::CENTER,
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

fn taffy_error(error: TaffyError) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

#[napi]
pub struct LayoutTree {
    tree: TaffyTree<u32>,
    nodes: Vec<NodeId>,
}

#[napi(object)]
pub struct MeasureInput {
    pub node: u32,
    pub known_width: Option<f64>,
    pub known_height: Option<f64>,
    pub available_width: Option<f64>,
    pub min_content: bool,
}
#[napi(object)]
pub struct MeasureOutput { pub width: f64, pub height: f64 }

#[napi]
impl LayoutTree {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            tree: TaffyTree::new(),
            nodes: Vec::new(),
        }
    }

    #[napi]
    pub fn create_node(&mut self, style: LayoutStyle) -> Result<u32> {
        let id = self
            .tree
            .new_leaf_with_context(convert_style(style)?, self.nodes.len() as u32)
            .map_err(taffy_error)?;
        let handle = u32::try_from(self.nodes.len())
            .map_err(|_| Error::new(Status::GenericFailure, "too many layout nodes"))?;
        self.nodes.push(id);
        Ok(handle)
    }

    #[napi]
    pub fn set_style(&mut self, handle: u32, style: LayoutStyle) -> Result<()> {
        let id = self.node(handle)?;
        self.tree
            .set_style(id, convert_style(style)?)
            .map_err(taffy_error)
    }

    #[napi]
    pub fn set_children(&mut self, handle: u32, children: Vec<u32>) -> Result<()> {
        let parent = self.node(handle)?;
        let children = children
            .into_iter()
            .map(|handle| self.node(handle))
            .collect::<Result<Vec<_>>>()?;
        self.tree
            .set_children(parent, &children)
            .map_err(taffy_error)
    }

    #[napi]
    pub fn invalidate(&mut self, handle: u32) -> Result<()> {
        let node = self.node(handle)?;
        self.tree.mark_dirty(node).map_err(taffy_error)
    }

    #[napi]
    pub fn set_rounding(&mut self, enabled: bool) {
        if enabled { self.tree.enable_rounding(); } else { self.tree.disable_rounding(); }
    }

    #[napi]
    pub fn compute(&mut self, root: u32, width: f64, height: f64,
        measure: Option<Function<'_, MeasureInput, MeasureOutput>>) -> Result<()> {
        let root = self.node(root)?;
        let width = finite_nonnegative(width, "viewport width")?;
        let height = finite_nonnegative(height, "viewport height")?;
        let mut failure = None;
        self.tree.compute_layout_with_measure(root,
            Size { width: AvailableSpace::Definite(width), height: AvailableSpace::Definite(height) },
            |inputs, _, node, style| taffy::compute_leaf_layout(inputs, style, |_, _| 0.0,
                |known, available| {
                    let (Some(callback), Some(node)) = (measure.as_ref(), node) else { return Size::ZERO; };
                    let request = MeasureInput { node: *node,
                        known_width: known.width.map(f64::from), known_height: known.height.map(f64::from),
                        available_width: match available.width { AvailableSpace::Definite(value) => Some(value as f64), _ => None },
                        min_content: matches!(available.width, AvailableSpace::MinContent) };
                    match callback.call(request) {
                        Ok(size) if size.width.is_finite() && size.height.is_finite() && size.width >= 0.0 && size.height >= 0.0 =>
                            Size { width: size.width as f32, height: size.height as f32 },
                        Ok(_) => { failure = Some(Error::new(Status::InvalidArg, "measure must return finite nonnegative dimensions")); Size::ZERO },
                        Err(error) => { failure = Some(error); Size::ZERO },
                    }
                })) .map_err(taffy_error)?;
        if let Some(error) = failure { return Err(error); }
        Ok(())
    }

    #[napi]
    pub fn layout(&self, handle: u32) -> Result<LayoutBox> {
        let layout = self.tree.layout(self.node(handle)?).map_err(taffy_error)?;
        Ok(LayoutBox {
            x: layout.location.x as f64,
            y: layout.location.y as f64,
            width: layout.size.width as f64,
            height: layout.size.height as f64,
            margin_top: layout.margin.top as f64,
            margin_right: layout.margin.right as f64,
            margin_bottom: layout.margin.bottom as f64,
            margin_left: layout.margin.left as f64,
            border_top: layout.border.top as f64,
            border_right: layout.border.right as f64,
            border_bottom: layout.border.bottom as f64,
            border_left: layout.border.left as f64,
            padding_top: layout.padding.top as f64,
            padding_right: layout.padding.right as f64,
            padding_bottom: layout.padding.bottom as f64,
            padding_left: layout.padding.left as f64,
        })
    }

    #[napi]
    pub fn layouts(&self, handles: Vec<u32>) -> Result<Vec<LayoutBox>> {
        handles
            .into_iter()
            .map(|handle| self.layout(handle))
            .collect()
    }
}

#[cfg(target_os = "android")]
static ANDROID_APP: OnceLock<winit::platform::android::activity::AndroidApp> = OnceLock::new();

#[cfg(target_os = "android")]
extern "C" {
    fn nasty_set_android_activity(
        java_vm: *mut std::ffi::c_void,
        activity: *mut std::ffi::c_void,
    );
    fn nasty_set_requested_orientation(orientation: i32) -> i32;
    fn nasty_node_start(script_path: *const std::ffi::c_char) -> i32;
    fn nasty_native_library_path() -> *const std::ffi::c_char;
}

#[cfg(target_os = "android")]
#[no_mangle]
pub fn android_main(android_app: winit::platform::android::activity::AndroidApp) {
    use std::ffi::{CStr, CString};

    unsafe {
        nasty_set_android_activity(android_app.vm_as_ptr(), android_app.activity_as_ptr())
    };
    if ANDROID_APP.set(android_app.clone()).is_err() {
        eprintln!("Nasty: Android app was initialized more than once");
        return;
    }

    let Some(files_dir) = android_app.internal_data_path() else {
        eprintln!("Nasty: Android did not provide an internal files directory");
        return;
    };
    let project_dir = files_dir.join("nasty");
    if let Err(error) = std::fs::remove_dir_all(&project_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Nasty: could not reset app files: {error}");
            return;
        }
    }
    if let Err(error) = std::fs::create_dir_all(&project_dir) {
        eprintln!("Nasty: could not create app directory: {error}");
        return;
    }
    let assets = android_app.asset_manager();
    let manifest_path = CString::new("nasty/files.list").expect("APK asset path");
    let Some(mut manifest) = assets.open(&manifest_path) else {
        eprintln!("Nasty: APK is missing its asset manifest");
        return;
    };
    let mut files = String::new();
    if let Err(error) = std::io::Read::read_to_string(&mut manifest, &mut files) {
        eprintln!("Nasty: could not read APK asset manifest: {error}");
        return;
    }
    let copy_result = (|| -> std::io::Result<()> {
        for relative_path in files.lines().filter(|line| !line.is_empty()) {
            let asset_path = format!("nasty/{relative_path}");
            let asset_c = CString::new(asset_path.as_str()).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid APK asset path")
            })?;
            let Some(mut asset) = assets.open(&asset_c) else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("APK asset {asset_path} is missing"),
                ));
            };
            let output = project_dir.join(relative_path);
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::io::copy(&mut asset, &mut std::fs::File::create(output)?)?;
        }
        Ok(())
    })();
    if let Err(error) = copy_result {
        eprintln!("Nasty: could not extract APK assets: {error}");
        return;
    }
    if let Err(error) = std::env::set_current_dir(&project_dir) {
        eprintln!("Nasty: could not enter app directory: {error}");
        return;
    }
    std::env::set_var("HOME", files_dir.join("home"));
    unsafe {
        let library_path = nasty_native_library_path();
        if !library_path.is_null() {
            std::env::set_var(
                "NASTY_NATIVE_PATH",
                CStr::from_ptr(library_path).to_string_lossy().as_ref(),
            );
        }
    }

    let script_path = project_dir.join("node/examples/tour.js");
    let script_path = match CString::new(script_path.to_string_lossy().as_bytes()) {
        Ok(path) => path,
        Err(_) => {
            eprintln!("Nasty: invalid tour script path");
            return;
        }
    };
    unsafe { nasty_node_start(script_path.as_ptr()) };
}

// Display list v1 is a Float32Array: [1, x, y, width, height, r, g, b, a, ...].
// Coordinates are physical window pixels and colors are straight RGBA in [0, 1].
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    position: [f32; 2],
    color: [f32; 4],
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct ImageVertex {
    position: [f32; 2],
    uv: [f32; 2],
    reciprocal_w: f32,
}

#[napi(object)]
pub struct ImageDraw {
    #[napi(js_name = "textureId")]
    pub texture_id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[napi(js_name = "clipX")]
    pub clip_x: Option<f64>,
    #[napi(js_name = "clipY")]
    pub clip_y: Option<f64>,
    #[napi(js_name = "clipWidth")]
    pub clip_width: Option<f64>,
    #[napi(js_name = "clipHeight")]
    pub clip_height: Option<f64>,
    pub vertices: Option<Vec<f64>>,
}

struct GpuImage {
    _texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
}

enum DrawOrder {
    Solids(std::ops::Range<u32>),
    Triangles(std::ops::Range<u32>),
    CanvasProgram {
        commands: Vec<CanvasCommand>,
        clip_x: f64,
        clip_y: f64,
        clip_width: f64,
        clip_height: f64,
    },
    CanvasTriangles {
        range: std::ops::Range<u32>,
        clip_x: f64,
        clip_y: f64,
        clip_width: f64,
        clip_height: f64,
    },
    Image(usize),
    BackdropBlur { x: f32, y: f32, width: f32, height: f32, radius: f32 },
}

enum CanvasCommand {
    Triangles(std::ops::Range<u32>),
    Circles(std::ops::Range<u32>),
    Beziers(std::ops::Range<u32>),
}

struct BackdropResources {
    source: wgpu::Texture,
    small: wgpu::Texture,
    horizontal: wgpu::Texture,
    blurred: wgpu::Texture,
    downsample_bind: wgpu::BindGroup,
    horizontal_bind: wgpu::BindGroup,
    vertical_bind: wgpu::BindGroup,
    composite_bind: wgpu::BindGroup,
    horizontal_params: wgpu::Buffer,
    vertical_params: wgpu::Buffer,
    downsample_pipeline: wgpu::RenderPipeline,
    blur_pipeline: wgpu::RenderPipeline,
    composite_pipeline: wgpu::RenderPipeline,
    width: u32,
    height: u32,
    small_width: u32,
    small_height: u32,
}

impl BackdropResources {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> Self {
        let small_width = (width / 4).max(1);
        let small_height = (height / 4).max(1);
        let make_texture = |label, width, height, usage| device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        });
        let sampled_target = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let source = make_texture("Nasty backdrop source", width, height,
            wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING);
        let small = make_texture("Nasty backdrop downsample", small_width, small_height, sampled_target);
        let horizontal = make_texture("Nasty backdrop horizontal blur", small_width, small_height, sampled_target);
        let blurred = make_texture("Nasty backdrop vertical blur", small_width, small_height, sampled_target);
        let source_view = source.create_view(&Default::default());
        let small_view = small.create_view(&Default::default());
        let horizontal_view = horizontal.create_view(&Default::default());
        let blurred_view = blurred.create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Nasty backdrop sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Nasty backdrop bindings"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
            ],
        });
        let make_params = |x: f32, y: f32| device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Nasty backdrop blur direction"),
            contents: bytemuck::cast_slice(&[x, y, 1.0, 0.0]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let horizontal_params = make_params(1.0, 0.0);
        let vertical_params = make_params(0.0, 1.0);
        let make_bind = |view: &wgpu::TextureView, params: Option<&wgpu::Buffer>| {
            let mut entries = vec![
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            ];
            if let Some(params) = params { entries.push(wgpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() }); }
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("Nasty backdrop bind group"), layout: &layout, entries: &entries })
        };
        let simple_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Nasty backdrop sampling bindings"), entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let make_simple_bind = |view: &wgpu::TextureView| device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Nasty backdrop sampling bind"), layout: &simple_layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let shader_source = r#"
            struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
            @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
                var p = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
                var o: Out; o.position = vec4(p[i],0.0,1.0); o.uv = vec2((p[i].x+1.0)*0.5, (1.0-p[i].y)*0.5); return o;
            }
        "#;
        let make_pipeline = |label: &'static str, fragment: String, bind_layout: &wgpu::BindGroupLayout| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(fragment.into()) });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(label), bind_group_layouts: &[bind_layout], push_constant_ranges: &[] });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label), layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: Default::default(),
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
                multiview: None, cache: None,
            })
        };
        let simple_shader = format!("{shader_source}\n@group(0) @binding(0) var tex: texture_2d<f32>; @group(0) @binding(1) var samp: sampler; @fragment fn fs(i: Out) -> @location(0) vec4<f32> {{ return textureSample(tex,samp,i.uv); }}");
        let blur_shader = format!("{shader_source}
            @group(0) @binding(0) var tex: texture_2d<f32>; @group(0) @binding(1) var samp: sampler;
            @group(0) @binding(2) var<uniform> params: vec4<f32>;
            @fragment fn fs(i: Out) -> @location(0) vec4<f32> {{
                let d = params.xy / vec2<f32>(textureDimensions(tex)) * max(params.z, 0.5);
                var c = textureSample(tex,samp,i.uv) * 0.227027;
                c += textureSample(tex,samp,i.uv + d*1.0) * 0.1945946; c += textureSample(tex,samp,i.uv - d*1.0) * 0.1945946;
                c += textureSample(tex,samp,i.uv + d*2.0) * 0.1216216; c += textureSample(tex,samp,i.uv - d*2.0) * 0.1216216;
                c += textureSample(tex,samp,i.uv + d*3.0) * 0.0702703; c += textureSample(tex,samp,i.uv - d*3.0) * 0.0702703;
                return c;
            }}");
        let downsample_pipeline = make_pipeline("Nasty backdrop downsample pipeline", simple_shader.clone(), &simple_layout);
        let composite_pipeline = make_pipeline("Nasty backdrop composite pipeline", simple_shader, &simple_layout);
        let blur_pipeline = make_pipeline("Nasty backdrop blur pipeline", blur_shader, &layout);
        Self { source, small, horizontal, blurred,
            downsample_bind: make_simple_bind(&source_view),
            horizontal_bind: make_bind(&small_view, Some(&horizontal_params)),
            vertical_bind: make_bind(&horizontal_view, Some(&vertical_params)),
            composite_bind: make_simple_bind(&blurred_view), horizontal_params, vertical_params,
            downsample_pipeline, blur_pipeline, composite_pipeline, width, height, small_width, small_height }
    }
}

#[napi(object)]
pub struct WindowOptions {
    pub title: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    #[napi(js_name = "allowAnyThread")]
    pub allow_any_thread: Option<bool>,
    pub visible: Option<bool>,
    pub resizable: Option<String>,
    pub orientation: Option<String>,
    pub borderless: Option<bool>,
    #[napi(js_name = "dragAnywhere")]
    pub drag_anywhere: Option<Either<bool, String>>,
    pub maximizable: Option<bool>,
    pub maximized: Option<bool>,
    pub vsync: Option<bool>,
}

#[napi(object)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct DisplaySize {
    pub width: f64,
    pub height: f64,
    #[napi(js_name = "scaleFactor")]
    pub scale_factor: f64,
}

#[napi(object)]
pub struct NativeEvent {
    #[napi(js_name = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub key: Option<String>,
    pub button: Option<u32>,
    pub text: Option<String>,
    pub modifiers: Option<String>,
    #[napi(js_name = "deltaX")]
    pub delta_x: Option<f64>,
    #[napi(js_name = "deltaY")]
    pub delta_y: Option<f64>,
}

#[napi(object)]
#[derive(Clone)]
pub struct TextAreaOptions {
    pub id: String,
    pub value: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[napi(js_name = "fontSize")]
    pub font_size: f64,
    #[napi(js_name = "lineHeight")]
    pub line_height: Option<f64>,
    pub multiline: Option<bool>,
    pub focus: Option<bool>,
    pub trace: Option<bool>,
}

#[napi(object)]
pub struct TextSelectionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct TextAreaState {
    pub value: String,
    #[napi(js_name = "displayText")]
    pub display_text: String,
    #[napi(js_name = "selectionStart")]
    pub selection_start: u32,
    #[napi(js_name = "selectionEnd")]
    pub selection_end: u32,
    #[napi(js_name = "caretIndex")]
    pub caret_index: u32,
    #[napi(js_name = "caretX")]
    pub caret_x: f64,
    #[napi(js_name = "caretY")]
    pub caret_y: f64,
    #[napi(js_name = "caretHeight")]
    pub caret_height: f64,
    #[napi(js_name = "editorCaretX")]
    pub editor_caret_x: f64,
    #[napi(js_name = "textOriginX")]
    pub text_origin_x: f64,
    #[napi(js_name = "textOriginY")]
    pub text_origin_y: f64,
    pub focused: bool,
    #[napi(js_name = "systemFontReady")]
    pub system_font_ready: bool,
    #[napi(js_name = "systemFontLoadMs")]
    pub system_font_load_ms: f64,
    #[napi(js_name = "selectionRects")]
    pub selection_rects: Vec<TextSelectionRect>,
}

#[napi(object)]
pub struct TextAreaGeometry {
    #[napi(js_name = "caretX")]
    pub caret_x: f64,
    #[napi(js_name = "caretY")]
    pub caret_y: f64,
    #[napi(js_name = "caretHeight")]
    pub caret_height: f64,
    #[napi(js_name = "selectionRects")]
    pub selection_rects: Vec<TextSelectionRect>,
}

#[napi(object)]
pub struct PresentStats {
    pub rendered: bool,
    #[napi(js_name = "nativeRenderMs")]
    pub native_render_ms: f64,
    #[napi(js_name = "prepareMs")]
    pub prepare_ms: f64,
    #[napi(js_name = "acquireMs")]
    pub acquire_ms: f64,
    #[napi(js_name = "submitMs")]
    pub submit_ms: f64,
    #[napi(js_name = "presentMs")]
    pub present_ms: f64,
}

#[cfg(target_os = "linux")]
#[napi(object)]
pub struct DecodedVideoFrame {
    pub width: u32,
    pub height: u32,
    #[napi(js_name = "sourceWidth")]
    pub source_width: u32,
    #[napi(js_name = "sourceHeight")]
    pub source_height: u32,
    pub pts: f64,
    #[napi(js_name = "frameDuration")]
    pub frame_duration: f64,
    pub pixels: Buffer,
}

#[cfg(target_os = "linux")]
#[napi(js_name = "VideoDecoder")]
pub struct NativeVideoDecoder {
    decoder: Option<ffmpeg_decode::Video>,
    duration: f64,
    frame_duration: f64,
    source_width: u32,
    source_height: u32,
}

#[cfg(target_os = "linux")]
#[napi(object)]
pub struct DecodedAudioChunk {
    pub pts: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub samples: Buffer,
}

#[cfg(target_os = "linux")]
#[napi(js_name = "AudioDecoder")]
pub struct NativeAudioDecoder {
    decoder: Option<ffmpeg_decode::Audio>,
}

#[cfg(target_os = "linux")]
#[napi]
impl NativeAudioDecoder {
    #[napi(constructor)]
    pub fn new(source: String) -> Result<Self> {
        let decoder = ffmpeg_decode::Audio::open(std::path::Path::new(&source))
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
        Ok(Self { decoder: Some(decoder) })
    }

    #[napi(getter, js_name = "sampleRate")]
    pub fn sample_rate(&self) -> u32 {
        self.decoder.as_ref().map(ffmpeg_decode::Audio::rate).unwrap_or(0)
    }

    #[napi(getter)]
    pub fn channels(&self) -> u32 {
        self.decoder.as_ref().map(ffmpeg_decode::Audio::channels).unwrap_or(0) as u32
    }

    #[napi]
    pub fn seek(&mut self, seconds: f64) -> Result<()> {
        self.decoder.as_mut().ok_or_else(|| Error::new(Status::GenericFailure, "audio decoder is closed"))?
            .seek(seconds.max(0.0)).map_err(|error| Error::new(Status::GenericFailure, error))
    }

    #[napi(js_name = "nextChunk")]
    pub fn next_chunk(&mut self) -> Result<Option<DecodedAudioChunk>> {
        let decoder = self.decoder.as_mut().ok_or_else(|| Error::new(Status::GenericFailure, "audio decoder is closed"))?;
        let Some(chunk) = decoder.next_chunk().map_err(|error| Error::new(Status::GenericFailure, error))? else {
            return Ok(None);
        };
        let channels = decoder.channels() as u32;
        let sample_rate = decoder.rate();
        let samples = bytemuck::cast_slice::<f32, u8>(&chunk.samples).to_vec();
        Ok(Some(DecodedAudioChunk { pts: chunk.pts, sample_rate, channels, samples: Buffer::from(samples) }))
    }

    #[napi]
    pub fn close(&mut self) { self.decoder.take(); }
}

#[cfg(target_os = "linux")]
#[napi]
impl NativeVideoDecoder {
    #[napi(constructor)]
    pub fn new(source: String) -> Result<Self> {
        let path = std::path::Path::new(&source);
        let probe = ffmpeg_decode::probe(path)
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
        let decoder = ffmpeg_decode::Video::open(std::path::Path::new(&source))
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
        let duration = probe.duration.unwrap_or(f64::NAN);
        let frame_duration = 1.0 / probe.frame_rate;
        Ok(Self { decoder: Some(decoder), duration, frame_duration,
            source_width: probe.width, source_height: probe.height })
    }

    #[napi(getter)]
    pub fn duration(&self) -> f64 {
        self.duration
    }

    #[napi(getter, js_name = "frameDuration")]
    pub fn frame_duration(&self) -> f64 {
        self.frame_duration
    }

    #[napi]
    pub fn seek(&mut self, seconds: f64) -> Result<()> {
        self.decoder.as_mut().ok_or_else(|| Error::new(Status::GenericFailure, "video decoder is closed"))?
            .seek(seconds.max(0.0))
            .map_err(|error| Error::new(Status::GenericFailure, error))
    }

    #[napi(js_name = "skipFrame")]
    pub fn skip_frame(&mut self) -> Result<Option<f64>> {
        let decoder = self.decoder.as_mut().ok_or_else(|| Error::new(Status::GenericFailure, "video decoder is closed"))?;
        let Some(held) = decoder.pull().map_err(|error| Error::new(Status::GenericFailure, error))? else {
            return Ok(None);
        };
        decoder.discard();
        Ok(Some(held.pts))
    }

    #[napi]
    pub fn close(&mut self) {
        self.decoder.take();
    }

    #[napi(js_name = "nextFrame")]
    pub fn next_frame(&mut self, max_edge: Option<u32>) -> Result<Option<DecodedVideoFrame>> {
        let decoder = self.decoder.as_mut().ok_or_else(|| Error::new(Status::GenericFailure, "video decoder is closed"))?;
        let held = decoder.pull()
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
        let Some(held) = held else { return Ok(None); };
        let frame = decoder.export(max_edge.unwrap_or(0))
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
        let row_bytes = (frame.width as usize).saturating_mul(4);
        if frame.stride as usize == row_bytes {
            Ok(Some(DecodedVideoFrame {
                width: frame.width,
                height: frame.height,
                source_width: self.source_width,
                source_height: self.source_height,
                pts: held.pts,
                frame_duration: self.frame_duration,
                pixels: Buffer::from(frame.rgba),
            }))
        } else {
            let mut packed = Vec::with_capacity(row_bytes * frame.height as usize);
            for row in frame.rgba.chunks(frame.stride as usize).take(frame.height as usize) {
                packed.extend_from_slice(&row[..row_bytes.min(row.len())]);
            }
            Ok(Some(DecodedVideoFrame {
                width: frame.width,
                height: frame.height,
                source_width: self.source_width,
                source_height: self.source_height,
                pts: held.pts,
                frame_duration: self.frame_duration,
                pixels: Buffer::from(packed),
            }))
        }
    }
}

#[napi(object)]
#[derive(Clone)]
pub struct TextRunOptions {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    #[napi(js_name = "fontSize")]
    pub font_size: f64,
    #[napi(js_name = "lineHeight")]
    pub line_height: f64,
    pub color: String,
    #[napi(js_name = "fontFamily")]
    pub font_family: Option<String>,
    #[napi(js_name = "fontWeight")]
    pub font_weight: Option<u16>,
    #[napi(js_name = "clipX")]
    pub clip_x: Option<f64>,
    #[napi(js_name = "clipY")]
    pub clip_y: Option<f64>,
    #[napi(js_name = "clipWidth")]
    pub clip_width: Option<f64>,
    #[napi(js_name = "clipHeight")]
    pub clip_height: Option<f64>,
    pub wrap: Option<bool>,
}

fn text_bounds(run: &TextRunOptions, width: u32, height: u32) -> TextBounds {
    let left = run
        .clip_x
        .unwrap_or(0.0)
        .floor()
        .clamp(0.0, i32::MAX as f64) as i32;
    let top = run
        .clip_y
        .unwrap_or(0.0)
        .floor()
        .clamp(0.0, i32::MAX as f64) as i32;
    let right = run
        .clip_x
        .zip(run.clip_width)
        .map(|(x, w)| (x + w).ceil().clamp(0.0, i32::MAX as f64) as i32)
        .unwrap_or(width.min(i32::MAX as u32) as i32);
    let bottom = run
        .clip_y
        .zip(run.clip_height)
        .map(|(y, h)| (y + h).ceil().clamp(0.0, i32::MAX as f64) as i32)
        .unwrap_or(height.min(i32::MAX as u32) as i32);
    TextBounds {
        left,
        top,
        right: right.max(left),
        bottom: bottom.max(top),
    }
}

fn text_family(family: Option<&str>) -> Family<'_> {
    let Some(family) = family else {
        return Family::SansSerif;
    };
    match family.trim().to_ascii_lowercase().as_str() {
        "serif" | "ui-serif" | "fangsong" => Family::Serif,
        "sans-serif" | "system-ui" | "ui-sans-serif" | "ui-rounded" => Family::SansSerif,
        "monospace" | "ui-monospace" => Family::Monospace,
        "cursive" => Family::Cursive,
        "fantasy" => Family::Fantasy,
        _ => Family::Name(family),
    }
}

#[napi(object)]
pub struct TextFontData {
    pub family: String,
    pub data: Buffer,
}

#[napi(object)]
pub struct TextPreparationStats {
    #[napi(js_name = "systemFontInitMs")]
    pub system_font_init_ms: f64,
    #[napi(js_name = "customFontLoadMs")]
    pub custom_font_load_ms: f64,
    #[napi(js_name = "glyphCount")]
    pub glyph_count: u32,
    #[napi(js_name = "lineCount")]
    pub line_count: u32,
    #[napi(js_name = "shapingMs")]
    pub shaping_ms: f64,
    #[napi(js_name = "atlasPrepareMs")]
    pub atlas_prepare_ms: f64,
    #[napi(js_name = "totalMs")]
    pub total_ms: f64,
    #[napi(js_name = "warmShapingMs")]
    pub warm_shaping_ms: f64,
    #[napi(js_name = "warmAtlasPrepareMs")]
    pub warm_atlas_prepare_ms: f64,
    #[napi(js_name = "warmTotalMs")]
    pub warm_total_ms: f64,
}

#[derive(Default, Clone, Copy)]
struct RenderTimings {
    total_ms: f64,
    prepare_ms: f64,
    acquire_ms: f64,
    submit_ms: f64,
    present_ms: f64,
}

struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    alpha_modes: Vec<wgpu::CompositeAlphaMode>,
    transparent: bool,
    pipeline: wgpu::RenderPipeline,
    canvas_pipeline: wgpu::RenderPipeline,
    canvas_viewport_bind_group: wgpu::BindGroup,
    canvas_viewport_buffer: wgpu::Buffer,
    canvas_circle_pipeline: wgpu::RenderPipeline,
    canvas_bezier_pipeline: wgpu::RenderPipeline,
    image_pipeline: wgpu::RenderPipeline,
    image_bind_group_layout: wgpu::BindGroupLayout,
    images: std::collections::HashMap<u32, GpuImage>,
    next_image_id: u32,
    image_vertex_buffer: wgpu::Buffer,
    image_vertex_capacity: usize,
    vertex_buffer: wgpu::Buffer,
    vertex_capacity: usize,
    canvas_vertex_buffer: wgpu::Buffer,
    canvas_vertex_capacity: usize,
    canvas_circle_vertex_buffer: wgpu::Buffer,
    canvas_circle_vertex_capacity: usize,
    canvas_bezier_vertex_buffer: wgpu::Buffer,
    canvas_bezier_vertex_capacity: usize,
    text_runtime: Option<TextRuntime>,
    worker_runtime: Option<TextRuntime>,
    text_worker: Sender<TextWorkerMessage>,
    text_results: Receiver<TextWorkerResult>,
    pending_text_request: Option<u32>,
    next_text_request: u32,
    active_text_request: u32,
    adapter_name: String,
    format_name: String,
    present_mode_name: String,
    supported_present_modes: Vec<wgpu::PresentMode>,
    backdrop: BackdropResources,
    surface_copy_src: bool,
}

struct PositionedText {
    buffer: TextBuffer,
    x: f32,
    y: f32,
    color: TextColor,
}

struct TextRuntime {
    font_system: Option<FontSystem>,
    system_font_init_ms: f64,
    loaded_custom_fonts: std::collections::HashSet<String>,
    swash_cache: SwashCache,
    text_viewport: Viewport,
    text_atlas: TextAtlas,
    text_renderer: Option<TextRenderer>,
    text_buffers: Vec<PositionedText>,
    text_run_options: Vec<TextRunOptions>,
}

struct TextEditor {
    context: egui::Context,
    winit: egui_winit::State,
    system_fonts: Receiver<std::result::Result<SystemEditorFont, String>>,
    system_font_ready: bool,
    system_font_load_ms: f64,
    system_font_bytes: Option<Vec<u8>>,
    system_font_family: Option<String>,
    caret_geometry_calibration: Option<CaretGeometryCalibration>,
    word_drag: Option<WordDragState>,
}

struct WordDragState {
    control_id: String,
    start: usize,
    end: usize,
    anchor: Option<usize>,
    dragging: bool,
    armed_for_followup: bool,
    tap_drag_active: bool,
    tap_drag_origin: Option<egui::Pos2>,
    tap_drag_last_pos: Option<egui::Pos2>,
    tap_drag_armed_at: Option<Instant>,
    tap_drag_last_motion: Option<Instant>,
    text: String,
}

fn egui_word_range(text: &str, cursor_index: usize) -> (usize, usize) {
    use egui::text::CCursor;
    use egui::text_selection::text_cursor_state::{
        ccursor_next_word, ccursor_previous_word, is_word_char,
    };

    let cursor = CCursor::new(cursor_index.min(text.chars().count()));
    if cursor.index == 0 {
        return (cursor.index, ccursor_next_word(text, cursor).index);
    }

    let mut chars = text.chars().skip(cursor.index - 1);
    if let Some(before) = chars.next() {
        if let Some(after) = chars.next() {
            if is_word_char(before) && is_word_char(after) {
                let start = ccursor_previous_word(text, cursor + 1);
                let end = ccursor_next_word(text, start);
                (start.index, end.index)
            } else if is_word_char(before) {
                let start = ccursor_previous_word(text, cursor);
                let end = ccursor_next_word(text, start);
                (start.index, end.index)
            } else if is_word_char(after) {
                (cursor.index, ccursor_next_word(text, cursor).index)
            } else {
                (
                    ccursor_previous_word(text, cursor).index,
                    ccursor_next_word(text, cursor).index,
                )
            }
        } else {
            (ccursor_previous_word(text, cursor).index, cursor.index)
        }
    } else {
        (cursor.index, ccursor_next_word(text, cursor).index)
    }
}

#[derive(Clone)]
struct CaretGeometryCalibration {
    control_id: String,
    rendered_x: f64,
    rendered_y: f64,
    rendered_height: f64,
}

struct SystemEditorFont {
    bytes: Vec<u8>,
    face_index: u32,
    family_name: String,
    load_ms: f64,
}

const SYSTEM_EDITOR_FONT_KEY: &str = "nasty-system-sans";

fn load_system_editor_font() -> std::result::Result<SystemEditorFont, String> {
    let started = Instant::now();
    let mut database = fontdb::Database::new();
    #[cfg(target_os = "android")]
    database
        .load_font_file("/system/fonts/Roboto-Regular.ttf")
        .map_err(|error| format!("could not load Android system font: {error}"))?;
    #[cfg(not(target_os = "android"))]
    database.load_system_fonts();
    let families = [fontdb::Family::SansSerif];
    let id = database
        .query(&fontdb::Query {
            families: &families,
            ..Default::default()
        })
        .ok_or_else(|| "no installed system sans-serif font was found".to_string())?;
    let (bytes, face_index) = database
        .with_face_data(id, |data, index| (data.to_vec(), index))
        .ok_or_else(|| "the selected system font has no readable font data".to_string())?;
    let family_name = database
        .face(id)
        .and_then(|face| face.families.first())
        .map(|(name, _)| name.clone())
        .ok_or_else(|| "the selected system font has no family name".to_string())?;
    Ok(SystemEditorFont {
        bytes,
        face_index,
        family_name,
        load_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn create_font_system() -> FontSystem {
    #[cfg(target_os = "android")]
    {
        let mut database = fontdb::Database::new();
        if let Err(error) = database.load_font_file("/system/fonts/Roboto-Regular.ttf") {
            eprintln!("Nasty: could not load Android system font: {error}");
        }
        FontSystem::new_with_locale_and_db("en-US".to_owned(), database)
    }
    #[cfg(not(target_os = "android"))]
    {
        FontSystem::new()
    }
}

impl TextEditor {
    fn new(window: &OsWindow) -> Self {
        let context = egui::Context::default();
        let winit = egui_winit::State::new(
            context.clone(),
            egui::ViewportId::ROOT,
            window,
            Some(window.scale_factor() as f32),
            None,
            None,
        );
        let (font_sender, system_fonts) = mpsc::channel();
        let _ = thread::Builder::new()
            .name("nasty-editor-system-font".into())
            .spawn(move || {
                let _ = font_sender.send(load_system_editor_font());
            });
        Self {
            context,
            winit,
            system_fonts,
            system_font_ready: false,
            system_font_load_ms: 0.0,
            system_font_bytes: None,
            system_font_family: None,
            caret_geometry_calibration: None,
            word_drag: None,
        }
    }

    fn on_window_event(&mut self, window: &OsWindow, event: &OsWindowEvent) {
        let _ = self.winit.on_window_event(window, event);
    }

    fn update_many(
        &mut self,
        window: &OsWindow,
        controls: Vec<TextAreaOptions>,
        renderer: Option<&Renderer>,
    ) -> Vec<TextAreaState> {
        if let Ok(Ok(font)) = self.system_fonts.try_recv() {
            self.system_font_bytes = Some(font.bytes.clone());
            self.system_font_family = Some(font.family_name.clone());
            let mut definitions = egui::FontDefinitions::default();
            let mut system_font = egui::FontData::from_owned(font.bytes);
            system_font.index = font.face_index;
            definitions.font_data.insert(
                SYSTEM_EDITOR_FONT_KEY.to_string(),
                std::sync::Arc::new(system_font),
            );
            definitions
                .families
                .get_mut(&egui::FontFamily::Proportional)
                .expect("proportional font family exists")
                .insert(0, SYSTEM_EDITOR_FONT_KEY.to_string());
            self.context.set_fonts(definitions);
            self.system_font_ready = true;
            self.system_font_load_ms = font.load_ms;
        }
        let input = self.winit.take_egui_input(window);
        let pixels_per_point = window.scale_factor() as f32;
        let mut edit_results = Vec::with_capacity(controls.len());
        let mut output = self.context.run(input, |context| {
            let mut visuals = egui::Visuals::dark();
            visuals.selection.bg_fill = egui::Color32::TRANSPARENT;
            visuals.selection.stroke = egui::Stroke::NONE;
            visuals.text_cursor.stroke = egui::Stroke::NONE;
            context.set_visuals(visuals);
            for options in &controls {
                let id = egui::Id::new(("nasty-text-control", options.id.clone()));
                let rect = egui::Rect::from_min_size(
                    egui::pos2(options.x as f32, options.y as f32) / pixels_per_point,
                    egui::vec2(options.width as f32, options.height as f32) / pixels_per_point,
                );
                let multiline = options.multiline.unwrap_or(true);
                let font_size = options.font_size.clamp(1.0, 256.0) as f32 / pixels_per_point;
                let line_height = options
                    .line_height
                    .filter(|height| height.is_finite() && *height > 0.0)
                    .map(|height| height.clamp(1.0, 512.0) as f32 / pixels_per_point)
                    .unwrap_or(font_size * 1.2);
                if options.focus.unwrap_or(false) {
                    context.memory_mut(|memory| memory.request_focus(id));
                }
                let mut value = options.value.clone();
                let mut layouter = |ui: &egui::Ui, text: &str, wrap_width: f32| {
                    let mut job = if multiline {
                        egui::text::LayoutJob::simple(
                            text.to_owned(),
                            egui::FontId::proportional(font_size),
                            egui::Color32::TRANSPARENT,
                            wrap_width,
                        )
                    } else {
                        egui::text::LayoutJob::simple_singleline(
                            text.to_owned(),
                            egui::FontId::proportional(font_size),
                            egui::Color32::TRANSPARENT,
                        )
                    };
                    job.sections[0].format.line_height = Some(line_height);
                    ui.fonts(|fonts| fonts.layout_job(job))
                };
                let edit = if multiline {
                    egui::TextEdit::multiline(&mut value)
                } else {
                    egui::TextEdit::singleline(&mut value)
                        .return_key(None)
                        .clip_text(true)
                        .vertical_align(egui::Align::Center)
                };
                let edit = egui::Area::new(egui::Id::new(("nasty-text-area", id)))
                    .fixed_pos(rect.min)
                    .order(egui::Order::Foreground)
                    .show(context, |ui| {
                        ui.set_clip_rect(rect);
                        ui.set_min_size(rect.size());
                        ui.set_max_size(rect.size());
                        edit.id(id)
                            .frame(false)
                            .margin(egui::Margin::ZERO)
                            .desired_width(rect.width())
                            .min_size(rect.size())
                            .font(egui::FontId::proportional(font_size))
                            .layouter(&mut layouter)
                            .text_color(egui::Color32::TRANSPARENT)
                            .show(ui)
                    })
                    .inner;
                edit_results.push((options.clone(), value, edit));
            }
        });
        let mut states = Vec::with_capacity(edit_results.len());
        for (options, value, mut edit) in edit_results {
            let font_size = options.font_size.clamp(1.0, 256.0) as f32 / pixels_per_point;
            if self.word_drag.as_ref().is_some_and(|state| {
                state.control_id == options.id && state.text != edit.galley.text()
            }) {
                self.word_drag = None;
            }
            let pointer_button = egui::PointerButton::Primary;
            let pointer_pressed = self
                .context
                .input(|input| input.pointer.button_pressed(pointer_button));
            let pointer_down = self
                .context
                .input(|input| input.pointer.button_down(pointer_button));
            let pointer_position = self.context.input(|input| input.pointer.latest_pos());
            let pointer_released = self
                .context
                .input(|input| input.pointer.button_released(pointer_button));
            // After a tap, egui only exposes interact_pointer_pos while a widget
            // owns an active press/drag. For touchpad tap-drag, movement can arrive
            // after that synthetic press has ended, so use the hover position while
            // our short-lived word-drag gesture is armed.
            let pointer_for_cursor = edit.response.interact_pointer_pos().or_else(|| {
                self.word_drag
                    .as_ref()
                    .filter(|state| state.control_id == options.id && state.tap_drag_active)
                    .and_then(|_| {
                        pointer_position.filter(|position| edit.response.rect.contains(*position))
                    })
            });
            let pointer_cursor = pointer_for_cursor.map(|pointer| {
                edit.galley
                    .cursor_from_pos(pointer - edit.galley_pos)
                    .ccursor
                    .index
            });
            if options.trace.unwrap_or(false)
                && (pointer_pressed
                    || pointer_released
                    || pointer_down
                    || edit.response.dragged_by(pointer_button)
                    || edit.response.double_clicked_by(pointer_button)
                    || edit.response.triple_clicked_by(pointer_button)
                    || self.word_drag.as_ref().is_some_and(|state| {
                        state.control_id == options.id && state.tap_drag_active
                    }) && self
                        .context
                        .input(|input| input.pointer.delta().length_sq() > 0.0))
            {
                let (double, triple, pos, delta) = self.context.input(|input| {
                    (
                        input.pointer.button_double_clicked(pointer_button),
                        input.pointer.button_triple_clicked(pointer_button),
                        input.pointer.latest_pos(),
                        input.pointer.delta(),
                    )
                });
                eprintln!(
                "[textarea pointer] pressed={pointer_pressed} released={pointer_released} down={pointer_down} double={double} triple={triple} dragged={} pos={pos:?} delta={delta:?} hit={pointer_cursor:?} range={:?} word_drag={:?}",
                edit.response.dragged_by(pointer_button),
                edit.cursor_range.map(|range| range.as_sorted_char_range()),
                self.word_drag
                    .as_ref()
                    .map(|state| {
                        (
                            state.start,
                            state.end,
                            state.anchor,
                            state.dragging,
                            state.armed_for_followup,
                            state.tap_drag_active,
                        )
                    }),
            );
            }
            // A touchpad's tap-and-drag gesture starts with a third tap on the
            // selected word. egui may classify that press as another multi-click
            // and replace the selection before the drag threshold is crossed.
            let continue_word_drag = pointer_pressed
                && pointer_cursor.is_some_and(|index| {
                    self.word_drag.as_ref().is_some_and(|state| {
                        state.control_id == options.id
                            && state.armed_for_followup
                            && state
                                .tap_drag_armed_at
                                .is_some_and(|armed| armed.elapsed() <= Duration::from_millis(650))
                            && (state.start..=state.end).contains(&index)
                    })
                });
            if continue_word_drag {
                if let Some(state) = self.word_drag.as_mut() {
                    state.armed_for_followup = false;
                    state.dragging = true;
                    state.anchor = None;
                    state.tap_drag_active = true;
                    state.tap_drag_origin = pointer_for_cursor;
                    state.tap_drag_last_pos = pointer_for_cursor;
                    state.tap_drag_armed_at = Some(Instant::now());
                    state.tap_drag_last_motion = None;
                    let range = egui::text::CursorRange::two(
                        edit.galley
                            .from_ccursor(egui::text::CCursor::new(state.start)),
                        edit.galley
                            .from_ccursor(egui::text::CCursor::new(state.end)),
                    );
                    edit.cursor_range = Some(range);
                    edit.state.cursor.set_range(Some(range));
                    edit.state.clone().store(&self.context, edit.response.id);
                }
            } else if pointer_pressed
                && pointer_released
                && pointer_down
                && !edit.response.double_clicked_by(pointer_button)
            {
                // Some touchpad drivers coalesce the first tap's release and the
                // second tap's press into one egui frame. If the second press is
                // then held and moved, egui sees only a normal drag and never emits
                // its double-click selection. Seed word selection before that drag.
                if let Some(pointer_index) = pointer_cursor {
                    let (start, end) = egui_word_range(edit.galley.text(), pointer_index);
                    if start != end {
                        self.word_drag = Some(WordDragState {
                            control_id: options.id.clone(),
                            start,
                            end,
                            anchor: None,
                            dragging: true,
                            armed_for_followup: false,
                            tap_drag_active: true,
                            tap_drag_origin: pointer_for_cursor,
                            tap_drag_last_pos: pointer_for_cursor,
                            tap_drag_armed_at: Some(Instant::now()),
                            tap_drag_last_motion: None,
                            text: edit.galley.text().to_owned(),
                        });
                        let range = egui::text::CursorRange::two(
                            edit.galley.from_ccursor(egui::text::CCursor::new(start)),
                            edit.galley.from_ccursor(egui::text::CCursor::new(end)),
                        );
                        edit.cursor_range = Some(range);
                        edit.state.cursor.set_range(Some(range));
                        edit.state.clone().store(&self.context, edit.response.id);
                    }
                }
            } else if edit.response.double_clicked_by(pointer_button) {
                if let Some(range) = edit.cursor_range.filter(|range| !range.is_empty()) {
                    let selected = range.as_sorted_char_range();
                    self.word_drag = Some(WordDragState {
                        control_id: options.id.clone(),
                        start: selected.start,
                        end: selected.end,
                        anchor: None,
                        dragging: pointer_down,
                        armed_for_followup: !pointer_down,
                        tap_drag_active: pointer_down,
                        tap_drag_origin: pointer_for_cursor,
                        tap_drag_last_pos: pointer_for_cursor,
                        tap_drag_armed_at: Some(Instant::now()),
                        tap_drag_last_motion: None,
                        text: edit.galley.text().to_owned(),
                    });
                }
            } else if pointer_pressed && pointer_cursor.is_some() {
                // A new press after a completed word drag starts a fresh selection
                // at that point, even if it lies inside the previous word range.
                self.word_drag = None;
            }
            if let (Some(state), Some(pointer_index)) = (self.word_drag.as_mut(), pointer_cursor) {
                if state.control_id != options.id {
                    // Word drag belongs to whichever text control initiated it.
                } else {
                    let now = Instant::now();
                    let mut tap_drag_motion = false;
                    if state.tap_drag_active {
                        if let Some(position) = pointer_position {
                            let moved = state
                                .tap_drag_last_pos
                                .is_some_and(|previous| previous.distance(position) >= 1.5);
                            let passed_drag_threshold = state
                                .tap_drag_origin
                                .is_some_and(|origin| origin.distance(position) >= 3.0);
                            if moved
                                && (passed_drag_threshold || state.tap_drag_last_motion.is_some())
                            {
                                state.tap_drag_last_pos = Some(position);
                                state.tap_drag_last_motion = Some(now);
                                tap_drag_motion = !pointer_down;
                            }
                        }
                        let started = state.tap_drag_armed_at.unwrap_or(now);
                        let expired_before_motion = state.tap_drag_last_motion.is_none()
                            && now.duration_since(started) > Duration::from_millis(650);
                        let idle_after_motion =
                            state.tap_drag_last_motion.is_some_and(|last_motion| {
                                now.duration_since(last_motion) > Duration::from_millis(500)
                            });
                        if expired_before_motion || idle_after_motion {
                            state.tap_drag_active = false;
                            if !pointer_down {
                                state.dragging = false;
                            }
                        }
                    }
                    let native_drag = pointer_down && edit.response.dragged_by(pointer_button);
                    if state.dragging && (native_drag || tap_drag_motion) {
                        if native_drag {
                            state.tap_drag_active = false;
                        }
                        if pointer_index < state.start {
                            state.anchor = Some(state.end);
                        } else if pointer_index > state.end {
                            state.anchor = Some(state.start);
                        }
                        if let Some(anchor) = state.anchor {
                            let (word_start, word_end) =
                                egui_word_range(edit.galley.text(), pointer_index);
                            let endpoint = if word_end <= anchor {
                                word_start
                            } else if word_start >= anchor {
                                word_end
                            } else {
                                anchor
                            };
                            let primary =
                                edit.galley.from_ccursor(egui::text::CCursor::new(endpoint));
                            let secondary =
                                edit.galley.from_ccursor(egui::text::CCursor::new(anchor));
                            let range = egui::text::CursorRange { primary, secondary };
                            edit.cursor_range = Some(range);
                            edit.state.cursor.set_range(Some(range));
                            edit.state.store(&self.context, edit.response.id);
                        } else {
                            let range = egui::text::CursorRange::two(
                                edit.galley
                                    .from_ccursor(egui::text::CCursor::new(state.start)),
                                edit.galley
                                    .from_ccursor(egui::text::CCursor::new(state.end)),
                            );
                            edit.cursor_range = Some(range);
                            edit.state.cursor.set_range(Some(range));
                            edit.state.store(&self.context, edit.response.id);
                        }
                    } else if !pointer_down && !state.tap_drag_active {
                        if state.anchor.is_some() {
                            if let Some(range) = edit.cursor_range.filter(|range| !range.is_empty())
                            {
                                let selected = range.as_sorted_char_range();
                                state.start = selected.start;
                                state.end = selected.end;
                                state.anchor = None;
                            }
                        }
                        state.dragging = false;
                    }
                }
            }
            let range = edit.cursor_range;
            let (selection_start, selection_end) = range
                .map(|range| {
                    let selected = range.as_sorted_char_range();
                    (selected.start, selected.end)
                })
                .unwrap_or((0, 0));
            let caret_index = range
                .map(|range| range.primary.ccursor.index)
                .unwrap_or(selection_end);
            let mut selection_rects = Vec::new();
            let mut caret_x = edit.galley_pos.x as f64;
            let mut caret_y = edit.galley_pos.y as f64;
            let mut caret_height = font_size as f64;
            if let Some(range) = range {
                let cursor = edit.galley.pos_from_cursor(&range.primary);
                caret_x = (edit.galley_pos.x + cursor.left()) as f64;
                caret_y = (edit.galley_pos.y + cursor.top()) as f64;
                caret_height = cursor.height() as f64;
                if !range.is_empty() {
                    let [start, end] = range.sorted_cursors();
                    for row_index in start.rcursor.row..=end.rcursor.row {
                        let Some(row) = edit.galley.rows.get(row_index) else {
                            continue;
                        };
                        let left = if row_index == start.rcursor.row {
                            row.x_offset(start.rcursor.column)
                        } else {
                            row.rect.left()
                        };
                        let right = if row_index == end.rcursor.row {
                            row.x_offset(end.rcursor.column)
                        } else {
                            row.rect.right()
                                + if row.ends_with_newline {
                                    row.height() * 0.5
                                } else {
                                    0.0
                                }
                        };
                        if right > left {
                            selection_rects.push(TextSelectionRect {
                                x: (edit.galley_pos.x + left) as f64 * pixels_per_point as f64,
                                y: (edit.galley_pos.y + row.min_y()) as f64
                                    * pixels_per_point as f64,
                                width: (right - left) as f64 * pixels_per_point as f64,
                                height: row.height() as f64 * pixels_per_point as f64,
                            });
                        }
                    }
                }
            }
            let mut state = TextAreaState {
                value,
                display_text: edit.galley.job.text.to_string(),
                selection_start: selection_start.min(u32::MAX as usize) as u32,
                selection_end: selection_end.min(u32::MAX as usize) as u32,
                caret_index: caret_index.min(u32::MAX as usize) as u32,
                caret_x: caret_x * pixels_per_point as f64,
                caret_y: caret_y * pixels_per_point as f64,
                caret_height: caret_height * pixels_per_point as f64,
                editor_caret_x: caret_x * pixels_per_point as f64,
                text_origin_x: edit.galley_pos.x as f64 * pixels_per_point as f64,
                text_origin_y: edit.galley_pos.y as f64 * pixels_per_point as f64,
                focused: edit.response.has_focus(),
                system_font_ready: self.system_font_ready,
                system_font_load_ms: self.system_font_load_ms,
                selection_rects,
            };
            let exact_geometry = renderer.and_then(|renderer| {
                renderer.textarea_geometry(
                    &state.display_text,
                    state.selection_start,
                    state.selection_end,
                    state.caret_index,
                )
            });
            if let Some((x, y, height, rects)) = exact_geometry {
                state.caret_x = x;
                state.caret_y = y;
                state.caret_height = height;
                state.selection_rects = rects;
                self.caret_geometry_calibration = Some(CaretGeometryCalibration {
                    control_id: options.id.clone(),
                    rendered_x: x,
                    rendered_y: y,
                    rendered_height: height,
                });
            } else if let Some(calibration) = self
                .caret_geometry_calibration
                .as_ref()
                .filter(|calibration| calibration.control_id == options.id)
            {
                state.caret_x = calibration.rendered_x;
                state.caret_y = calibration.rendered_y;
                state.caret_height = calibration.rendered_height;
            }
            if state.focused
                && self
                    .caret_geometry_calibration
                    .as_ref()
                    .is_some_and(|calibration| calibration.control_id == options.id)
            {
                if let Some(ime) = output.platform_output.ime.as_mut() {
                    let caret_rect = egui::Rect::from_min_size(
                        egui::pos2(state.caret_x as f32, state.caret_y as f32) / pixels_per_point,
                        egui::vec2(1.0, state.caret_height as f32) / pixels_per_point,
                    );
                    ime.rect = caret_rect;
                    ime.cursor_rect = caret_rect;
                }
            }
            states.push(state);
        }
        self.winit
            .handle_platform_output(window, output.platform_output);
        states
    }
}

struct TextWorkerMessage {
    request_id: u32,
    runs: Vec<TextRunOptions>,
    custom_fonts: Vec<(String, Vec<u8>)>,
    runtime: TextRuntime,
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
}

struct TextWorkerResult {
    request_id: u32,
    runtime: TextRuntime,
    stats: std::result::Result<TextPreparationStats, String>,
}

fn create_text_runtime(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
) -> TextRuntime {
    let cache = TextCache::new(device);
    let mut viewport = Viewport::new(device, &cache);
    viewport.update(queue, Resolution { width, height });
    let atlas = TextAtlas::new(device, queue, &cache, format);
    TextRuntime {
        font_system: None,
        system_font_init_ms: 0.0,
        loaded_custom_fonts: std::collections::HashSet::new(),
        swash_cache: SwashCache::new(),
        text_viewport: viewport,
        text_atlas: atlas,
        text_renderer: None,
        text_buffers: Vec::new(),
        text_run_options: Vec::new(),
    }
}

impl Renderer {
    fn select_present_mode(
        supported: &[wgpu::PresentMode],
        vsync: bool,
    ) -> Option<wgpu::PresentMode> {
        let preferred = if vsync {
            [wgpu::PresentMode::Fifo, wgpu::PresentMode::Mailbox, wgpu::PresentMode::Immediate]
        } else {
            [wgpu::PresentMode::Immediate, wgpu::PresentMode::Mailbox, wgpu::PresentMode::Fifo]
        };
        preferred.into_iter().find(|mode| supported.contains(mode))
    }

    fn new(window: Arc<OsWindow>, transparent: bool, vsync: bool) -> std::result::Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::from_env().unwrap_or_else(|| if cfg!(target_os = "android") {
                wgpu::Backends::GL
            } else {
                wgpu::Backends::all()
            }),
            ..Default::default()
        });
        let surface = instance
            .create_surface(window.clone())
            .map_err(|error| format!("create GPU surface: {error}"))?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
        }))
        .ok_or_else(|| "find GPU adapter: no compatible adapter".to_string())?;
        let adapter_name = adapter.get_info().name;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("Nasty device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|error| format!("create GPU device: {error}"))?;
        device.on_uncaptured_error(Box::new(|error| {
            eprintln!("Nasty WGPU uncaptured error: {error}");
        }));

        let capabilities = surface.get_capabilities(&adapter);
        let surface_copy_src = capabilities.usages.contains(wgpu::TextureUsages::COPY_SRC);
        let format = capabilities
            .formats
            .iter()
            .copied()
            .find(wgpu::TextureFormat::is_srgb)
            .or_else(|| capabilities.formats.first().copied())
            .ok_or_else(|| "GPU surface has no supported formats".to_string())?;
        let format_name = format!("{format:?}");
        let supported_present_modes = capabilities.present_modes.clone();
        let present_mode = Self::select_present_mode(&supported_present_modes, vsync)
            .ok_or_else(|| "GPU surface has no presentation modes".to_string())?;
        let present_mode_name = format!("{present_mode:?}");
        let preferred_alpha = if transparent { wgpu::CompositeAlphaMode::PreMultiplied } else { wgpu::CompositeAlphaMode::Opaque };
        let alpha_mode = capabilities.alpha_modes.iter().copied().find(|mode| *mode == preferred_alpha)
            .or_else(|| capabilities.alpha_modes.first().copied())
            .ok_or_else(|| "GPU surface has no alpha modes".to_string())?;
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | if surface_copy_src { wgpu::TextureUsages::COPY_SRC } else { wgpu::TextureUsages::empty() },
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode,
            desired_maximum_frame_latency: if present_mode == wgpu::PresentMode::Mailbox {
                1
            } else {
                2
            },
            alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Nasty quad shader"),
            source: wgpu::ShaderSource::Wgsl(
                r#"
                struct VertexInput {
                    @location(0) position: vec2<f32>,
                    @location(1) color: vec4<f32>,
                };
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) color: vec4<f32>,
                };
                @vertex fn vs_main(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = vec4<f32>(input.position, 0.0, 1.0);
                    output.color = input.color;
                    return output;
                }
                @fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                    return input.color;
                }
                "#
                .into(),
            ),
        });
        const ATTRIBUTES: [wgpu::VertexAttribute; 2] =
            wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
        let vertex_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &ATTRIBUTES,
        };
        let targets = [Some(wgpu::ColorTargetState {
            format,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Nasty quad pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[vertex_layout.clone()],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview: None,
            cache: None,
        });
        let canvas_viewport_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Nasty canvas viewport binding"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: std::num::NonZeroU64::new(8),
                },
                count: None,
            }],
        });
        let canvas_viewport_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Nasty canvas viewport"),
            contents: bytemuck::cast_slice(&[config.width as f32, config.height as f32]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let canvas_viewport_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Nasty canvas viewport bind group"),
            layout: &canvas_viewport_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: canvas_viewport_buffer.as_entire_binding() }],
        });
        let canvas_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Nasty canvas pixel-coordinate shader"),
            source: wgpu::ShaderSource::Wgsl(r#"
                struct Viewport { size: vec2<f32> };
                @group(0) @binding(0) var<uniform> viewport: Viewport;
                struct VertexInput {
                    @location(0) position: vec2<f32>,
                    @location(1) color: vec4<f32>,
                };
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) color: vec4<f32>,
                };
                @vertex fn vs_main(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    let x = input.position.x / viewport.size.x * 2.0 - 1.0;
                    let y = 1.0 - input.position.y / viewport.size.y * 2.0;
                    output.position = vec4<f32>(x, y, 0.0, 1.0);
                    output.color = input.color;
                    return output;
                }
                @fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                    return input.color;
                }
            "#.into()),
        });
        let canvas_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Nasty canvas pipeline layout"),
            bind_group_layouts: &[&canvas_viewport_layout],
            push_constant_ranges: &[],
        });
        let canvas_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Nasty canvas pixel-coordinate pipeline"),
            layout: Some(&canvas_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &canvas_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[vertex_layout],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &canvas_shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview: None,
            cache: None,
        });
        let canvas_circle_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Nasty canvas radial circle shader"),
            source: wgpu::ShaderSource::Wgsl(r#"
                struct Viewport { size: vec2<f32> };
                @group(0) @binding(0) var<uniform> viewport: Viewport;
                struct CircleInput {
                    @location(0) center: vec2<f32>,
                    @location(1) outer_radius: f32,
                    @location(2) inner_radius: f32,
                    @location(3) gradient_center: vec2<f32>,
                    @location(4) gradient_radii: vec2<f32>,
                    @location(5) inner_color: vec4<f32>,
                    @location(6) outer_color: vec4<f32>,
                };
                struct CircleOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) local: vec2<f32>,
                    @location(1) center: vec2<f32>,
                    @location(2) inner_radius: f32,
                    @location(3) outer_radius: f32,
                    @location(4) gradient_center: vec2<f32>,
                    @location(5) gradient_radii: vec2<f32>,
                    @location(6) inner_color: vec4<f32>,
                    @location(7) outer_color: vec4<f32>,
                };
                @vertex fn vs_main(input: CircleInput, @builtin(vertex_index) vertex_index: u32) -> CircleOutput {
                    let corners = array<vec2<f32>, 6>(
                        vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
                        vec2<f32>(-1.0,1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0));
                    let local = corners[vertex_index] * input.outer_radius;
                    let point = input.center + local;
                    var output: CircleOutput;
                    output.position = vec4<f32>(point.x / viewport.size.x * 2.0 - 1.0,
                        1.0 - point.y / viewport.size.y * 2.0, 0.0, 1.0);
                    output.local = local;
                    output.center = input.center;
                    output.inner_radius = input.inner_radius;
                    output.outer_radius = input.outer_radius;
                    output.gradient_center = input.gradient_center;
                    output.gradient_radii = input.gradient_radii;
                    output.inner_color = input.inner_color;
                    output.outer_color = input.outer_color;
                    return output;
                }
                @fragment fn fs_main(input: CircleOutput) -> @location(0) vec4<f32> {
                    let circle_distance = length(input.local);
                    if (circle_distance > input.outer_radius || (input.inner_radius >= 0.0 && circle_distance < input.inner_radius)) { discard; }
                    let gradient_distance = length(input.center + input.local - input.gradient_center);
                    let t = clamp((gradient_distance - input.gradient_radii.x) / max(0.0001, input.gradient_radii.y - input.gradient_radii.x), 0.0, 1.0);
                    return mix(input.inner_color, input.outer_color, t);
                }
            "#.into()),
        });
        const CIRCLE_ATTRIBUTES: [wgpu::VertexAttribute; 7] = wgpu::vertex_attr_array![
            0 => Float32x2, 1 => Float32, 2 => Float32, 3 => Float32x2,
            4 => Float32x2, 5 => Float32x4, 6 => Float32x4
        ];
        let circle_layout = wgpu::VertexBufferLayout {
            array_stride: 16 * std::mem::size_of::<f32>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &CIRCLE_ATTRIBUTES,
        };
        let canvas_circle_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Nasty canvas radial circle pipeline"),
            layout: Some(&canvas_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &canvas_circle_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[circle_layout],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &canvas_circle_shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview: None,
            cache: None,
        });
        let canvas_bezier_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Nasty canvas bezier stroke shader"),
            source: wgpu::ShaderSource::Wgsl(r#"
                struct Viewport { size: vec2<f32> };
                @group(0) @binding(0) var<uniform> viewport: Viewport;
                struct BezierInput {
                    @location(0) p0: vec2<f32>, @location(1) p1: vec2<f32>,
                    @location(2) p2: vec2<f32>, @location(3) p3: vec2<f32>,
                    @location(4) half_width: f32, @location(5) color: vec4<f32>,
                };
                struct BezierOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) color: vec4<f32>,
                };
                fn curve(input: BezierInput, t: f32) -> vec2<f32> {
                    let s = 1.0 - t;
                    return input.p0 * (s*s*s) + input.p1 * (3.0*s*s*t)
                        + input.p2 * (3.0*s*t*t) + input.p3 * (t*t*t);
                }
                @vertex fn vs_main(input: BezierInput, @builtin(vertex_index) vertex_index: u32) -> BezierOutput {
                    let segment = vertex_index / 6u;
                    let corner = vertex_index % 6u;
                    let a = curve(input, f32(segment) / 16.0);
                    let b = curve(input, f32(segment + 1u) / 16.0);
                    let direction = b - a;
                    let normal = select(vec2<f32>(0.0, input.half_width), normalize(vec2<f32>(-direction.y, direction.x)) * input.half_width, dot(direction, direction) > 0.000001);
                    var point = a + normal;
                    switch corner {
                        case 1u, 4u: { point = a - normal; }
                        case 2u, 3u: { point = b + normal; }
                        case 5u: { point = b - normal; }
                        default: {}
                    }
                    var output: BezierOutput;
                    output.position = vec4<f32>(point.x / viewport.size.x * 2.0 - 1.0,
                        1.0 - point.y / viewport.size.y * 2.0, 0.0, 1.0);
                    output.color = input.color;
                    return output;
                }
                @fragment fn fs_main(input: BezierOutput) -> @location(0) vec4<f32> { return input.color; }
            "#.into()),
        });
        const BEZIER_ATTRIBUTES: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![
            0 => Float32x2, 1 => Float32x2, 2 => Float32x2, 3 => Float32x2,
            4 => Float32, 5 => Float32x4
        ];
        let bezier_layout = wgpu::VertexBufferLayout {
            array_stride: 13 * std::mem::size_of::<f32>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &BEZIER_ATTRIBUTES,
        };
        let canvas_bezier_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Nasty canvas bezier stroke pipeline"),
            layout: Some(&canvas_pipeline_layout),
            vertex: wgpu::VertexState { module: &canvas_bezier_shader, entry_point: Some("vs_main"),
                compilation_options: Default::default(), buffers: &[bezier_layout] },
            primitive: wgpu::PrimitiveState::default(), depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &canvas_bezier_shader, entry_point: Some("fs_main"),
                compilation_options: Default::default(), targets: &targets }),
            multiview: None, cache: None,
        });
        let image_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Nasty image bindings"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let image_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Nasty image pipeline layout"),
                bind_group_layouts: &[&image_bind_group_layout],
                push_constant_ranges: &[],
            });
        let image_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Nasty image shader"),
            source: wgpu::ShaderSource::Wgsl(r#"
                struct VertexInput {
                    @location(0) position: vec2<f32>,
                    @location(1) uv: vec2<f32>,
                    @location(2) reciprocal_w: f32,
                };
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) uv: vec2<f32>,
                };
                @vertex fn vs_main(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = vec4<f32>(input.position * input.reciprocal_w, 0.0, input.reciprocal_w);
                    output.uv = input.uv;
                    return output;
                }
                @group(0) @binding(0) var image_texture: texture_2d<f32>;
                @group(0) @binding(1) var image_sampler: sampler;
                @fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                    return textureSample(image_texture, image_sampler, input.uv);
                }
            "#.into()),
        });
        const IMAGE_ATTRIBUTES: [wgpu::VertexAttribute; 3] =
            wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32];
        let image_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<ImageVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &IMAGE_ATTRIBUTES,
        };
        let image_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Nasty image pipeline"),
            layout: Some(&image_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &image_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[image_vertex_layout],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &image_shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview: None,
            cache: None,
        });
        // Avoid a visible first-frame allocation for ordinary display lists.
        // Larger lists still grow geometrically in `render`.
        let vertex_capacity = 64 * 6 * std::mem::size_of::<Vertex>();
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty display list vertices"),
            size: vertex_capacity as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let canvas_vertex_capacity = 4 * 1024 * 1024;
        let canvas_vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty canvas triangle vertices"),
            size: canvas_vertex_capacity as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let canvas_circle_vertex_capacity = 64 * 1024;
        let canvas_circle_vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty canvas radial circle instances"),
            size: canvas_circle_vertex_capacity as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let canvas_bezier_vertex_capacity = 64 * 1024;
        let canvas_bezier_vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty canvas bezier instances"), size: canvas_bezier_vertex_capacity as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
        // Create the first staging upload before the animation loop without
        // waiting for the GPU; the first real frame flushes this queued upload.
        let warmup_data = vec![0_u8; vertex_capacity];
        queue.write_buffer(&vertex_buffer, 0, &warmup_data);
        let image_vertex_capacity = 6 * std::mem::size_of::<ImageVertex>();
        let image_vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty image vertices"),
            size: image_vertex_capacity as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Keep the active atlas on the render thread while the spare runtime
        // shapes and uploads the next text version on the worker.
        let text_runtime =
            create_text_runtime(&device, &queue, format, config.width, config.height);
        let worker_runtime =
            create_text_runtime(&device, &queue, format, config.width, config.height);
        let (text_worker, text_jobs) = mpsc::channel::<TextWorkerMessage>();
        let (text_result_sender, text_results) = mpsc::channel::<TextWorkerResult>();
        thread::Builder::new()
            .name("nasty-text-preparation".into())
            .spawn(move || {
                while let Ok(mut job) = text_jobs.recv() {
                    let stats = job.runtime.set_text_runs(
                        job.runs,
                        &job.custom_fonts,
                        &job.device,
                        &job.queue,
                        job.width,
                        job.height,
                    );
                    if text_result_sender
                        .send(TextWorkerResult {
                            request_id: job.request_id,
                            runtime: job.runtime,
                            stats,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|error| format!("start text worker: {error}"))?;

        let backdrop = BackdropResources::new(&device, format, config.width, config.height);
        Ok(Self {
            surface,
            device,
            queue,
            config,
            alpha_modes: capabilities.alpha_modes.clone(),
            transparent,
            pipeline,
            canvas_pipeline,
            canvas_viewport_bind_group,
            canvas_viewport_buffer,
            canvas_circle_pipeline,
            canvas_bezier_pipeline,
            image_pipeline,
            image_bind_group_layout,
            images: std::collections::HashMap::new(),
            next_image_id: 1,
            image_vertex_buffer,
            image_vertex_capacity,
            vertex_buffer,
            vertex_capacity,
            canvas_vertex_buffer,
            canvas_vertex_capacity,
            canvas_circle_vertex_buffer,
            canvas_circle_vertex_capacity,
            canvas_bezier_vertex_buffer,
            canvas_bezier_vertex_capacity,
            text_runtime: Some(text_runtime),
            worker_runtime: Some(worker_runtime),
            text_worker,
            text_results,
            pending_text_request: None,
            next_text_request: 1,
            active_text_request: 0,
            adapter_name,
            format_name,
            present_mode_name,
            supported_present_modes,
            backdrop,
            surface_copy_src,
        })
    }

    fn set_vsync(&mut self, vsync: bool) -> std::result::Result<(), String> {
        let present_mode = Self::select_present_mode(&self.supported_present_modes, vsync)
            .ok_or_else(|| "GPU surface has no presentation modes".to_string())?;
        if present_mode == self.config.present_mode { return Ok(()); }
        self.config.present_mode = present_mode;
        self.config.desired_maximum_frame_latency = if present_mode == wgpu::PresentMode::Mailbox { 1 } else { 2 };
        self.surface.configure(&self.device, &self.config);
        self.present_mode_name = format!("{present_mode:?}");
        Ok(())
    }

    fn upload_image(
        &mut self,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> std::result::Result<u32, String> {
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err("image dimensions must be between 1 and 16384 pixels".into());
        }
        if pixels.len() != width as usize * height as usize * 4 {
            return Err("decoded image must contain width × height × 4 RGBA bytes".into());
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Nasty decoded image"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Nasty image sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Nasty image bind group"),
            layout: &self.image_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let id = self.next_image_id;
        self.next_image_id = self.next_image_id.wrapping_add(1).max(1);
        self.images.insert(
            id,
            GpuImage {
                _texture: texture,
                bind_group,
                width,
                height,
            },
        );
        Ok(id)
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.queue.write_buffer(&self.canvas_viewport_buffer, 0,
            bytemuck::cast_slice(&[width as f32, height as f32]));
        self.surface.configure(&self.device, &self.config);
        self.backdrop = BackdropResources::new(&self.device, self.config.format, width, height);
        if let Some(runtime) = self.text_runtime.as_mut() {
            runtime
                .text_viewport
                .update(&self.queue, Resolution { width, height });
        }
    }

    fn set_transparent(&mut self, window: &OsWindow, transparent: bool) {
        let preferred = if transparent { wgpu::CompositeAlphaMode::PreMultiplied } else { wgpu::CompositeAlphaMode::Opaque };
        if let Some(mode) = self.alpha_modes.iter().copied().find(|mode| *mode == preferred)
            .or_else(|| self.alpha_modes.first().copied())
        {
            self.config.alpha_mode = mode;
            self.transparent = transparent;
            self.surface.configure(&self.device, &self.config);
            window.request_redraw();
        }
    }

    fn render(
        &mut self,
        window: &OsWindow,
        list: &[f32],
        triangles: &[f32],
        circles: &[f32],
        beziers: &[f32],
        image_draws: &[ImageDraw],
        draw_order: &[DrawOrder],
    ) -> std::result::Result<RenderTimings, String> {
        let started = Instant::now();
        let prepare_started = Instant::now();
        let mut vertices = Vec::with_capacity((list.len() / 8) * 6);
        let width = self.config.width as f32;
        let height = self.config.height as f32;
        let canvas_direct = draw_order.iter().any(|command| matches!(command, DrawOrder::CanvasProgram { .. }));
        for quad in list.chunks_exact(8) {
            let [x, y, w, h, r, g, b, a] = [
                quad[0], quad[1], quad[2], quad[3], quad[4], quad[5], quad[6], quad[7],
            ];
            let left = x / width * 2.0 - 1.0;
            let right = (x + w) / width * 2.0 - 1.0;
            let top = 1.0 - y / height * 2.0;
            let bottom = 1.0 - (y + h) / height * 2.0;
            let color = [r, g, b, a];
            vertices.extend_from_slice(&[
                Vertex {
                    position: [left, top],
                    color,
                },
                Vertex {
                    position: [right, top],
                    color,
                },
                Vertex {
                    position: [left, bottom],
                    color,
                },
                Vertex {
                    position: [left, bottom],
                    color,
                },
                Vertex {
                    position: [right, top],
                    color,
                },
                Vertex {
                    position: [right, bottom],
                    color,
                },
            ]);
        }
        let triangle_vertex_offset = vertices.len() as u32;
        if canvas_direct {
            let bytes = std::mem::size_of_val(triangles);
            if bytes > self.canvas_vertex_capacity {
                self.canvas_vertex_capacity = bytes.next_power_of_two();
                self.canvas_vertex_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Nasty canvas triangle vertices"),
                    size: self.canvas_vertex_capacity as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
            }
            if !triangles.is_empty() {
                self.queue.write_buffer(&self.canvas_vertex_buffer, 0, bytemuck::cast_slice(triangles));
            }
            let circle_bytes = std::mem::size_of_val(circles);
            if circle_bytes > self.canvas_circle_vertex_capacity {
                self.canvas_circle_vertex_capacity = circle_bytes.next_power_of_two();
                self.canvas_circle_vertex_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Nasty canvas radial circle instances"),
                    size: self.canvas_circle_vertex_capacity as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
            }
            if !circles.is_empty() {
                self.queue.write_buffer(&self.canvas_circle_vertex_buffer, 0, bytemuck::cast_slice(circles));
            }
            let bezier_bytes = std::mem::size_of_val(beziers);
            if bezier_bytes > self.canvas_bezier_vertex_capacity {
                self.canvas_bezier_vertex_capacity = bezier_bytes.next_power_of_two();
                self.canvas_bezier_vertex_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Nasty canvas bezier instances"), size: self.canvas_bezier_vertex_capacity as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
                });
            }
            if !beziers.is_empty() {
                self.queue.write_buffer(&self.canvas_bezier_vertex_buffer, 0, bytemuck::cast_slice(beziers));
            }
        } else {
            for vertex in triangles.chunks_exact(6) {
                let x = vertex[0] / width * 2.0 - 1.0;
                let y = 1.0 - vertex[1] / height * 2.0;
                vertices.push(Vertex {
                    position: [x, y],
                    color: [vertex[2], vertex[3], vertex[4], vertex[5]],
                });
            }
        }
        let bytes = bytemuck::cast_slice(&vertices);
        if bytes.len() > self.vertex_capacity {
            self.vertex_capacity = bytes.len().next_power_of_two();
            self.vertex_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Nasty display list vertices"),
                size: self.vertex_capacity as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if !bytes.is_empty() {
            self.queue.write_buffer(&self.vertex_buffer, 0, bytes);
        }
        let prepare_ms = prepare_started.elapsed().as_secs_f64() * 1000.0;

        let mut image_vertices = Vec::with_capacity(image_draws.len() * 6);
        let mut image_batches = Vec::with_capacity(image_draws.len());
        for image in image_draws {
            let gpu_image = self
                .images
                .get(&image.texture_id)
                .ok_or_else(|| format!("unknown image texture {}", image.texture_id))?;
            if let Some(vertices) = image.vertices.as_ref() {
                if vertices.is_empty() || vertices.len() % 15 != 0 {
                    return Err("transformed image vertices must contain complete triangles".into());
                }
                let cx = image.clip_x.unwrap_or(0.0).floor().clamp(0.0, width as f64) as u32;
                let cy = image
                    .clip_y
                    .unwrap_or(0.0)
                    .floor()
                    .clamp(0.0, height as f64) as u32;
                let cr = image
                    .clip_x
                    .zip(image.clip_width)
                    .map(|(x, w)| (x + w).ceil().clamp(0.0, width as f64) as u32)
                    .unwrap_or(self.config.width);
                let cb = image
                    .clip_y
                    .zip(image.clip_height)
                    .map(|(y, h)| (y + h).ceil().clamp(0.0, height as f64) as u32)
                    .unwrap_or(self.config.height);
                if cr <= cx || cb <= cy {
                    image_batches.push(None);
                    continue;
                }
                let start = image_vertices.len() as u32;
                for vertex in vertices.chunks_exact(5) {
                    let (x, y, u, v, reciprocal_w) =
                        (vertex[0], vertex[1], vertex[2], vertex[3], vertex[4]);
                    if !x.is_finite()
                        || !y.is_finite()
                        || !u.is_finite()
                        || !v.is_finite()
                        || !reciprocal_w.is_finite()
                        || reciprocal_w <= 0.0
                    {
                        return Err("transformed image vertex contains an invalid value".into());
                    }
                    image_vertices.push(ImageVertex {
                        position: [
                            (x as f32 / width as f32) * 2.0 - 1.0,
                            1.0 - (y as f32 / height as f32) * 2.0,
                        ],
                        uv: [u as f32, v as f32],
                        reciprocal_w: reciprocal_w as f32,
                    });
                }
                let end = image_vertices.len() as u32;
                image_batches.push(Some((
                    image.texture_id,
                    start..end,
                    cx,
                    cy,
                    cr - cx,
                    cb - cy,
                )));
                let _intrinsic_size = (gpu_image.width, gpu_image.height);
                continue;
            }
            let x0 = image.x.max(0.0);
            let y0 = image.y.max(0.0);
            let x1 = (image.x + image.width).min(width as f64);
            let y1 = (image.y + image.height).min(height as f64);
            if image.width <= 0.0 || image.height <= 0.0 || x1 <= x0 || y1 <= y0 {
                image_batches.push(None);
                continue;
            }
            let u0 = ((x0 - image.x) / image.width) as f32;
            let v0 = ((y0 - image.y) / image.height) as f32;
            let u1 = ((x1 - image.x) / image.width) as f32;
            let v1 = ((y1 - image.y) / image.height) as f32;
            let px0 = x0 as f32 / width * 2.0 - 1.0;
            let px1 = x1 as f32 / width * 2.0 - 1.0;
            let py0 = 1.0 - y0 as f32 / height * 2.0;
            let py1 = 1.0 - y1 as f32 / height * 2.0;
            let start = image_vertices.len() as u32;
            image_vertices.extend_from_slice(&[
                ImageVertex {
                    position: [px0, py0],
                    uv: [u0, v0],
                    reciprocal_w: 1.0,
                },
                ImageVertex {
                    position: [px1, py0],
                    uv: [u1, v0],
                    reciprocal_w: 1.0,
                },
                ImageVertex {
                    position: [px0, py1],
                    uv: [u0, v1],
                    reciprocal_w: 1.0,
                },
                ImageVertex {
                    position: [px0, py1],
                    uv: [u0, v1],
                    reciprocal_w: 1.0,
                },
                ImageVertex {
                    position: [px1, py0],
                    uv: [u1, v0],
                    reciprocal_w: 1.0,
                },
                ImageVertex {
                    position: [px1, py1],
                    uv: [u1, v1],
                    reciprocal_w: 1.0,
                },
            ]);
            let cx = image.clip_x.unwrap_or(0.0).floor().clamp(0.0, width as f64) as u32;
            let cy = image
                .clip_y
                .unwrap_or(0.0)
                .floor()
                .clamp(0.0, height as f64) as u32;
            let cr = image
                .clip_x
                .zip(image.clip_width)
                .map(|(x, w)| (x + w).ceil().clamp(0.0, width as f64) as u32)
                .unwrap_or(self.config.width);
            let cb = image
                .clip_y
                .zip(image.clip_height)
                .map(|(y, h)| (y + h).ceil().clamp(0.0, height as f64) as u32)
                .unwrap_or(self.config.height);
            if cr <= cx || cb <= cy {
                image_vertices.truncate(start as usize);
                image_batches.push(None);
                continue;
            }
            image_batches.push(Some((
                image.texture_id,
                start..start + 6,
                cx,
                cy,
                cr - cx,
                cb - cy,
            )));
            let _intrinsic_size = (gpu_image.width, gpu_image.height);
        }
        let image_bytes = bytemuck::cast_slice(&image_vertices);
        if image_bytes.len() > self.image_vertex_capacity {
            self.image_vertex_capacity = image_bytes.len().next_power_of_two();
            self.image_vertex_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Nasty image vertices"),
                size: self.image_vertex_capacity as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if !image_bytes.is_empty() {
            self.queue
                .write_buffer(&self.image_vertex_buffer, 0, image_bytes);
        }

        let acquire_started = Instant::now();
        let frame = match self.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.resize(window.inner_size().width, window.inner_size().height);
                self.surface
                    .get_current_texture()
                    .map_err(|error| format!("acquire GPU frame after resize: {error}"))?
            }
            Err(error) => return Err(format!("acquire GPU frame: {error}")),
        };
        let acquire_ms = acquire_started.elapsed().as_secs_f64() * 1000.0;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Nasty frame encoder"),
            });
        if draw_order.iter().any(|command| matches!(command, DrawOrder::BackdropBlur { .. })) {
            {
                let attachments = [Some(wgpu::RenderPassColorAttachment {
                    view: &view, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(if self.transparent {
                        wgpu::Color::TRANSPARENT
                    } else { wgpu::Color { r: 0.035, g: 0.047, b: 0.078, a: 1.0 } }), store: wgpu::StoreOp::Store },
                })];
                let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Nasty backdrop frame clear"), color_attachments: &attachments,
                    depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None,
                });
            }
            for command in draw_order {
                if let DrawOrder::BackdropBlur { x, y, width, height, radius } = command {
                    if !self.surface_copy_src {
                        return Err("GPU surface does not support copy-out required for backdrop-filter".into());
                    }
                    self.encode_backdrop_blur(&mut encoder, &frame.texture, *x, *y, *width, *height, *radius)?;
                    continue;
                }
                let attachments = [Some(wgpu::RenderPassColorAttachment {
                    view: &view, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })];
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Nasty ordered display command"), color_attachments: &attachments,
                    depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None,
                });
                match command {
                    DrawOrder::Solids(range) => {
                        pass.set_pipeline(&self.pipeline); pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                        pass.draw(range.clone(), 0..1);
                    }
                    DrawOrder::Triangles(range) => {
                        pass.set_pipeline(&self.pipeline); pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                        pass.draw((triangle_vertex_offset + range.start)..(triangle_vertex_offset + range.end), 0..1);
                    }
                    DrawOrder::CanvasProgram { commands, clip_x, clip_y, clip_width, clip_height } => {
                        let left = clip_x.floor().clamp(0.0, width as f64) as u32;
                        let top = clip_y.floor().clamp(0.0, height as f64) as u32;
                        let right = (*clip_x + *clip_width).ceil().clamp(0.0, width as f64) as u32;
                        let bottom = (*clip_y + *clip_height).ceil().clamp(0.0, height as f64) as u32;
                        if right > left && bottom > top {
                            pass.set_scissor_rect(left, top, right-left, bottom-top);
                            for primitive in commands {
                                match primitive {
                                    CanvasCommand::Triangles(range) if !range.is_empty() => {
                                        pass.set_pipeline(&self.canvas_pipeline);
                                        pass.set_bind_group(0, &self.canvas_viewport_bind_group, &[]);
                                        pass.set_vertex_buffer(0, self.canvas_vertex_buffer.slice(..));
                                        pass.draw(range.clone(), 0..1);
                                    }
                                    CanvasCommand::Circles(range) if !range.is_empty() => {
                                        pass.set_pipeline(&self.canvas_circle_pipeline);
                                        pass.set_bind_group(0, &self.canvas_viewport_bind_group, &[]);
                                        pass.set_vertex_buffer(0, self.canvas_circle_vertex_buffer.slice(..));
                                        pass.draw(0..6, range.clone());
                                    }
                                    CanvasCommand::Beziers(range) if !range.is_empty() => {
                                        pass.set_pipeline(&self.canvas_bezier_pipeline);
                                        pass.set_bind_group(0, &self.canvas_viewport_bind_group, &[]);
                                        pass.set_vertex_buffer(0, self.canvas_bezier_vertex_buffer.slice(..));
                                        pass.draw(0..96, range.clone());
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    DrawOrder::CanvasTriangles { range, clip_x, clip_y, clip_width, clip_height } => {
                        let left = clip_x.floor().clamp(0.0, width as f64) as u32;
                        let top = clip_y.floor().clamp(0.0, height as f64) as u32;
                        let right = (*clip_x + *clip_width).ceil().clamp(0.0, width as f64) as u32;
                        let bottom = (*clip_y + *clip_height).ceil().clamp(0.0, height as f64) as u32;
                        if right > left && bottom > top {
                            pass.set_pipeline(&self.canvas_pipeline); pass.set_bind_group(0, &self.canvas_viewport_bind_group, &[]);
                            pass.set_vertex_buffer(0, self.canvas_vertex_buffer.slice(..));
                            pass.set_scissor_rect(left, top, right-left, bottom-top);
                            pass.draw(range.clone(), 0..1);
                        }
                    }
                    DrawOrder::Image(index) => if let Some((texture_id, range, x, y, w, h)) = image_batches.get(*index).and_then(Option::as_ref) {
                        pass.set_pipeline(&self.image_pipeline); pass.set_vertex_buffer(0, self.image_vertex_buffer.slice(..));
                        pass.set_scissor_rect(*x, *y, *w, *h);
                        pass.set_bind_group(0, &self.images[texture_id].bind_group, &[]); pass.draw(range.clone(), 0..1);
                    },
                    DrawOrder::BackdropBlur { .. } => unreachable!(),
                }
            }
            if let Some(runtime) = self.text_runtime.as_ref().filter(|runtime| !runtime.text_buffers.is_empty()) {
                if let Some(text_renderer) = runtime.text_renderer.as_ref() {
                    let attachments = [Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })];
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("Nasty text pass"),
                        color_attachments: &attachments, depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
                    text_renderer.render(&runtime.text_atlas, &runtime.text_viewport, &mut pass)
                        .map_err(|error| format!("render text: {error}"))?;
                }
            }
        } else {
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: &view, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(if self.transparent {
                    wgpu::Color::TRANSPARENT
                } else { wgpu::Color { r: 0.035, g: 0.047, b: 0.078, a: 1.0 } }), store: wgpu::StoreOp::Store },
            })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("Nasty display list pass"),
                color_attachments: &attachments, depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
            if draw_order.is_empty() {
                if !vertices.is_empty() { pass.set_pipeline(&self.pipeline); pass.set_vertex_buffer(0, self.vertex_buffer.slice(..)); pass.draw(0..vertices.len() as u32, 0..1); }
                for batch in image_batches.iter().flatten() {
                    let (texture_id, range, x, y, w, h) = batch;
                    pass.set_pipeline(&self.image_pipeline); pass.set_vertex_buffer(0, self.image_vertex_buffer.slice(..));
                    pass.set_scissor_rect(*x, *y, *w, *h); pass.set_bind_group(0, &self.images[texture_id].bind_group, &[]); pass.draw(range.clone(), 0..1);
                }
            } else {
                for command in draw_order {
                    match command {
                        DrawOrder::Solids(range) => { pass.set_pipeline(&self.pipeline); pass.set_vertex_buffer(0, self.vertex_buffer.slice(..)); pass.draw(range.clone(), 0..1); }
                        DrawOrder::Triangles(range) => { pass.set_pipeline(&self.pipeline); pass.set_vertex_buffer(0, self.vertex_buffer.slice(..)); pass.draw((triangle_vertex_offset + range.start)..(triangle_vertex_offset + range.end), 0..1); }
                        DrawOrder::CanvasProgram { commands, clip_x, clip_y, clip_width, clip_height } => {
                            let left=clip_x.floor().clamp(0.0,width as f64) as u32; let top=clip_y.floor().clamp(0.0,height as f64) as u32;
                            let right=(*clip_x+*clip_width).ceil().clamp(0.0,width as f64) as u32; let bottom=(*clip_y+*clip_height).ceil().clamp(0.0,height as f64) as u32;
                            if right>left && bottom>top {
                                pass.set_scissor_rect(left,top,right-left,bottom-top);
                                for primitive in commands {
                                    match primitive {
                                        CanvasCommand::Triangles(range) if !range.is_empty() => { pass.set_pipeline(&self.canvas_pipeline); pass.set_bind_group(0,&self.canvas_viewport_bind_group,&[]); pass.set_vertex_buffer(0,self.canvas_vertex_buffer.slice(..)); pass.draw(range.clone(),0..1); }
                                        CanvasCommand::Circles(range) if !range.is_empty() => { pass.set_pipeline(&self.canvas_circle_pipeline); pass.set_bind_group(0,&self.canvas_viewport_bind_group,&[]); pass.set_vertex_buffer(0,self.canvas_circle_vertex_buffer.slice(..)); pass.draw(0..6,range.clone()); }
                                        CanvasCommand::Beziers(range) if !range.is_empty() => { pass.set_pipeline(&self.canvas_bezier_pipeline); pass.set_bind_group(0,&self.canvas_viewport_bind_group,&[]); pass.set_vertex_buffer(0,self.canvas_bezier_vertex_buffer.slice(..)); pass.draw(0..96,range.clone()); }
                                        _ => {}
                                    }
                                }
                                pass.set_scissor_rect(0,0,self.config.width,self.config.height);
                            }
                        }
                        DrawOrder::CanvasTriangles { range, clip_x, clip_y, clip_width, clip_height } => {
                            let left=clip_x.floor().clamp(0.0,width as f64) as u32; let top=clip_y.floor().clamp(0.0,height as f64) as u32;
                            let right=(*clip_x+*clip_width).ceil().clamp(0.0,width as f64) as u32; let bottom=(*clip_y+*clip_height).ceil().clamp(0.0,height as f64) as u32;
                            if right>left && bottom>top { pass.set_pipeline(&self.canvas_pipeline); pass.set_bind_group(0,&self.canvas_viewport_bind_group,&[]); pass.set_vertex_buffer(0,self.canvas_vertex_buffer.slice(..)); pass.set_scissor_rect(left,top,right-left,bottom-top); pass.draw(range.clone(),0..1); pass.set_scissor_rect(0,0,self.config.width,self.config.height); }
                        }
                        DrawOrder::Image(index) => if let Some((texture_id,range,x,y,w,h))=image_batches.get(*index).and_then(Option::as_ref) { pass.set_pipeline(&self.image_pipeline); pass.set_vertex_buffer(0,self.image_vertex_buffer.slice(..)); pass.set_scissor_rect(*x,*y,*w,*h); pass.set_bind_group(0,&self.images[texture_id].bind_group,&[]); pass.draw(range.clone(),0..1); },
                        DrawOrder::BackdropBlur { .. } => unreachable!(),
                    }
                }
            }
            pass.set_scissor_rect(0,0,self.config.width,self.config.height);
            if let Some(runtime) = self.text_runtime.as_ref().filter(|runtime| !runtime.text_buffers.is_empty()) {
                if let Some(text_renderer) = runtime.text_renderer.as_ref() { text_renderer.render(&runtime.text_atlas,&runtime.text_viewport,&mut pass).map_err(|error|format!("render text: {error}"))?; }
            }
        }
        let submit_started = Instant::now();
        self.queue.submit(Some(encoder.finish()));
        let submit_ms = submit_started.elapsed().as_secs_f64() * 1000.0;
        let present_started = Instant::now();
        frame.present();
        let present_ms = present_started.elapsed().as_secs_f64() * 1000.0;
        Ok(RenderTimings {
            total_ms: started.elapsed().as_secs_f64() * 1000.0,
            prepare_ms,
            acquire_ms,
            submit_ms,
            present_ms,
        })
    }

    fn encode_backdrop_blur(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        surface: &wgpu::Texture,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
    ) -> std::result::Result<(), String> {
        if width <= 0.0 || height <= 0.0 { return Ok(()); }
        let resources = &self.backdrop;
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: surface, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &resources.source, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: resources.width, height: resources.height, depth_or_array_layers: 1 },
        );
        let sigma = (radius.max(0.0) / 12.0).max(0.5);
        self.queue.write_buffer(&resources.horizontal_params, 0, bytemuck::cast_slice(&[1.0_f32, 0.0, sigma, 0.0]));
        self.queue.write_buffer(&resources.vertical_params, 0, bytemuck::cast_slice(&[0.0_f32, 1.0, sigma, 0.0]));
        for (label, texture, pipeline, bind_group, w, h) in [
            ("Nasty backdrop downsample", &resources.small, &resources.downsample_pipeline, &resources.downsample_bind, resources.small_width, resources.small_height),
            ("Nasty backdrop horizontal", &resources.horizontal, &resources.blur_pipeline, &resources.horizontal_bind, resources.small_width, resources.small_height),
            ("Nasty backdrop vertical", &resources.blurred, &resources.blur_pipeline, &resources.vertical_bind, resources.small_width, resources.small_height),
        ] {
            let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let attachments = [Some(wgpu::RenderPassColorAttachment { view: &target, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some(label), color_attachments: &attachments,
                depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
            pass.set_viewport(0.0, 0.0, w as f32, h as f32, 0.0, 1.0);
            pass.set_pipeline(pipeline); pass.set_bind_group(0, bind_group, &[]); pass.draw(0..3, 0..1);
        }
        let left = x.floor().clamp(0.0, self.config.width as f32) as u32;
        let top = y.floor().clamp(0.0, self.config.height as f32) as u32;
        let right = (x + width).ceil().clamp(0.0, self.config.width as f32) as u32;
        let bottom = (y + height).ceil().clamp(0.0, self.config.height as f32) as u32;
        if right > left && bottom > top {
            let surface_view = surface.create_view(&wgpu::TextureViewDescriptor::default());
            let attachments = [Some(wgpu::RenderPassColorAttachment { view: &surface_view, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("Nasty backdrop composite"), color_attachments: &attachments,
                depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
            pass.set_scissor_rect(left, top, right-left, bottom-top);
            pass.set_pipeline(&resources.composite_pipeline); pass.set_bind_group(0, &resources.composite_bind, &[]); pass.draw(0..3, 0..1);
        }
        Ok(())
    }

    fn request_text_runs(
        &mut self,
        mut runs: Vec<TextRunOptions>,
        custom_fonts: Vec<TextFontData>,
        system_font: Option<(String, Vec<u8>)>,
    ) -> std::result::Result<u32, String> {
        if self.pending_text_request.is_some() {
            return Err("a text preparation request is already pending".into());
        }
        let runtime = self
            .worker_runtime
            .take()
            .ok_or_else(|| "text resources are busy".to_string())?;
        let request_id = self.next_text_request;
        self.next_text_request = self.next_text_request.wrapping_add(1).max(1);
        let mut custom_fonts = custom_fonts
            .into_iter()
            .map(|font| (font.family, font.data.to_vec()))
            .collect::<Vec<_>>();
        if let Some((family_name, data)) = system_font {
            for run in &mut runs {
                if run.font_family.is_none() {
                    run.font_family = Some(family_name.clone());
                }
            }
            if !custom_fonts
                .iter()
                .any(|(family, _)| family == &family_name)
            {
                custom_fonts.push((family_name, data));
            }
        }
        let job = TextWorkerMessage {
            request_id,
            runs,
            custom_fonts,
            runtime,
            device: self.device.clone(),
            queue: self.queue.clone(),
            width: self.config.width,
            height: self.config.height,
        };
        if let Err(error) = self.text_worker.send(job) {
            self.worker_runtime = Some(error.0.runtime);
            return Err("text worker is unavailable".into());
        }
        self.pending_text_request = Some(request_id);
        self.active_text_request = request_id;
        Ok(request_id)
    }

    fn set_text_runs_now(
        &mut self,
        mut runs: Vec<TextRunOptions>,
        custom_fonts: Vec<TextFontData>,
        system_font: Option<(String, Vec<u8>)>,
        update_run_index: Option<usize>,
    ) -> std::result::Result<TextPreparationStats, String> {
        let mut custom_fonts = custom_fonts
            .into_iter()
            .map(|font| (font.family, font.data.to_vec()))
            .collect::<Vec<_>>();
        if let Some((family_name, data)) = system_font {
            for run in &mut runs {
                if run.font_family.is_none() {
                    run.font_family = Some(family_name.clone());
                }
            }
            if !custom_fonts
                .iter()
                .any(|(family, _)| family == &family_name)
            {
                custom_fonts.push((family_name, data));
            }
        }
        let request_id = self.next_text_request;
        self.next_text_request = self.next_text_request.wrapping_add(1).max(1);
        let runtime = self
            .text_runtime
            .as_mut()
            .ok_or_else(|| "active text resources are unavailable".to_string())?;
        let stats = if let Some(index) = update_run_index
            .filter(|index| *index < runs.len() && runtime.text_buffers.len() == runs.len())
        {
            runtime.set_text_run(
                index,
                runs.swap_remove(index),
                &custom_fonts,
                &self.device,
                &self.queue,
                self.config.width,
                self.config.height,
            )?
        } else {
            runtime.set_text_runs(
                runs,
                &custom_fonts,
                &self.device,
                &self.queue,
                self.config.width,
                self.config.height,
            )?
        };
        self.active_text_request = request_id;
        Ok(stats)
    }

    fn textarea_geometry_for_api(
        &self,
        text: &str,
        selection_start: u32,
        selection_end: u32,
        caret_index: u32,
    ) -> Option<TextAreaGeometry> {
        let (caret_x, caret_y, caret_height, selection_rects) =
            Renderer::textarea_geometry(self, text, selection_start, selection_end, caret_index)?;
        Some(TextAreaGeometry {
            caret_x,
            caret_y,
            caret_height,
            selection_rects,
        })
    }

    fn poll_text_runs(&mut self) -> std::result::Result<Option<TextPreparationStats>, String> {
        match self.text_results.try_recv() {
            Ok(result) => {
                if self.pending_text_request != Some(result.request_id) {
                    self.worker_runtime = Some(result.runtime);
                    return Ok(None);
                }
                self.pending_text_request = None;
                if result.request_id != self.active_text_request {
                    self.worker_runtime = Some(result.runtime);
                    return Ok(None);
                }
                self.worker_runtime = self.text_runtime.replace(result.runtime);
                if let Some(runtime) = self.text_runtime.as_mut() {
                    runtime.text_viewport.update(
                        &self.queue,
                        Resolution {
                            width: self.config.width,
                            height: self.config.height,
                        },
                    );
                }
                result.stats.map(Some)
            }
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err("text worker stopped unexpectedly".into()),
        }
    }

    fn system_font_init_ms(&self) -> f64 {
        self.text_runtime
            .as_ref()
            .map(|runtime| runtime.system_font_init_ms)
            .unwrap_or(0.0)
    }
}

impl TextRuntime {
    fn prepare_text_areas(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
    ) -> std::result::Result<(), String> {
        if self.text_buffers.is_empty() {
            return Ok(());
        }
        if self.text_renderer.is_none() {
            self.text_renderer = Some(TextRenderer::new(
                &mut self.text_atlas,
                device,
                wgpu::MultisampleState::default(),
                None,
            ));
        }
        self.text_viewport
            .update(queue, Resolution { width, height });
        let areas = self
            .text_buffers
            .iter()
            .zip(&self.text_run_options)
            .filter_map(|(text, options)| {
                let bounds = text_bounds(options, width, height);
                (bounds.right > bounds.left && bounds.bottom > bounds.top).then_some(TextArea {
                    buffer: &text.buffer,
                    left: text.x,
                    top: text.y,
                    scale: 1.0,
                    bounds,
                    default_color: text.color,
                    custom_glyphs: &[],
                })
            })
            .collect::<Vec<_>>();
        let font_system = self
            .font_system
            .as_mut()
            .ok_or_else(|| "font system is unavailable".to_string())?;
        self.text_renderer
            .as_mut()
            .expect("text renderer initialized")
            .prepare(
                device,
                queue,
                font_system,
                &mut self.text_atlas,
                &self.text_viewport,
                areas,
                &mut self.swash_cache,
            )
            .map_err(|error| error.to_string())
    }

    fn set_text_run(
        &mut self,
        index: usize,
        run: TextRunOptions,
        custom_fonts: &[(String, Vec<u8>)],
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
    ) -> std::result::Result<TextPreparationStats, String> {
        if index >= self.text_buffers.len() {
            return Err("text run index is outside the active text list".into());
        }
        let total_started = Instant::now();
        if self.font_system.is_none() {
            let font_init_started = Instant::now();
            self.font_system = Some(create_font_system());
            self.system_font_init_ms = font_init_started.elapsed().as_secs_f64() * 1000.0;
        }
        let font_system = self.font_system.as_mut().expect("font system initialized");
        let font_load_started = Instant::now();
        for (family, data) in custom_fonts {
            if self.loaded_custom_fonts.insert(family.clone()) {
                font_system.db_mut().load_font_data(data.clone());
            }
        }
        let custom_font_load_ms = font_load_started.elapsed().as_secs_f64() * 1000.0;
        let [x, y, run_width, font_size, line_height] =
            [run.x, run.y, run.width, run.font_size, run.line_height];
        if [x, y, run_width, font_size, line_height]
            .iter()
            .any(|value| !value.is_finite())
            || run_width < 0.0
            || font_size <= 0.0
            || line_height <= 0.0
            || run_width > f32::MAX as f64
            || font_size > f32::MAX as f64
            || line_height > f32::MAX as f64
        {
            return Err("text run geometry and font metrics must be finite; width must be nonnegative and font size/line height positive".into());
        }
        let color = parse_text_color(&run.color)
            .ok_or_else(|| format!("invalid text color: {}", run.color))?;
        let shaping_started = Instant::now();
        let previous_options = self.text_run_options.get(index);
        let same_style = previous_options.is_some_and(|previous| {
            previous.width == run.width
                && previous.font_size == run.font_size
                && previous.line_height == run.line_height
                && previous.color == run.color
                && previous.font_family == run.font_family
                && previous.clip_x == run.clip_x
                && previous.clip_y == run.clip_y
                && previous.clip_width == run.clip_width
                && previous.clip_height == run.clip_height
                && previous.wrap == run.wrap
        });
        if same_style {
            let old_text = self.text_buffers[index]
                .buffer
                .lines
                .iter()
                .map(|line| line.text())
                .collect::<Vec<_>>()
                .join("\n");
            if old_text == run.text {
                self.text_buffers[index].x = x as f32;
                self.text_buffers[index].y = y as f32;
                self.text_run_options[index] = run.clone();
            } else {
                let old_chars = old_text.chars().collect::<Vec<_>>();
                let new_chars = run.text.chars().collect::<Vec<_>>();
                let prefix = old_chars
                    .iter()
                    .zip(&new_chars)
                    .take_while(|(old, new)| old == new)
                    .count();
                let suffix = old_chars[prefix..]
                    .iter()
                    .rev()
                    .zip(new_chars[prefix..].iter().rev())
                    .take_while(|(old, new)| old == new)
                    .count();
                let inserted = new_chars[prefix..new_chars.len() - suffix]
                    .iter()
                    .collect::<String>();
                let start = cosmic_cursor_at_char(&self.text_buffers[index].buffer, prefix);
                let end = cosmic_cursor_at_char(
                    &self.text_buffers[index].buffer,
                    old_chars.len() - suffix,
                );
                let mut editor = Editor::new(&mut self.text_buffers[index].buffer);
                editor.set_cursor(start);
                editor.set_selection(glyphon::cosmic_text::Selection::Normal(end));
                editor.insert_string(&inserted, None);
                editor.shape_as_needed(font_system, false);
                self.text_buffers[index].x = x as f32;
                self.text_buffers[index].y = y as f32;
                self.text_run_options[index] = run.clone();
            }
        } else {
            let mut buffer =
                TextBuffer::new_empty(Metrics::new(font_size as f32, line_height as f32));
            buffer.set_wrap(
                font_system,
                if run.wrap == Some(false) {
                    Wrap::None
                } else {
                    Wrap::Word
                },
            );
            buffer.set_size(
                font_system,
                Some((run_width as f32).max(1.0)),
                Some((height as f32 - y as f32).max(1.0)),
            );
            buffer.set_text(
                font_system,
                &run.text,
                Attrs::new()
                    .family(text_family(run.font_family.as_deref()))
                    .weight(Weight(run.font_weight.unwrap_or(400))),
                Shaping::Advanced,
            );
            self.text_buffers[index] = PositionedText {
                buffer,
                x: x as f32,
                y: y as f32,
                color,
            };
            if self.text_run_options.len() <= index {
                self.text_run_options.resize_with(index + 1, || run.clone());
            }
            self.text_run_options[index] = run;
        }
        let mut glyph_count = 0_u32;
        let mut line_count = 0_u32;
        for layout_run in self.text_buffers[index].buffer.layout_runs() {
            line_count += 1;
            glyph_count += layout_run.glyphs.len() as u32;
        }
        let shaping_ms = shaping_started.elapsed().as_secs_f64() * 1000.0;
        let prepare_started = Instant::now();
        self.prepare_text_areas(device, queue, width, height)?;
        let atlas_prepare_ms = prepare_started.elapsed().as_secs_f64() * 1000.0;
        Ok(TextPreparationStats {
            system_font_init_ms: self.system_font_init_ms,
            custom_font_load_ms,
            glyph_count,
            line_count,
            shaping_ms,
            atlas_prepare_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            warm_shaping_ms: 0.0,
            warm_atlas_prepare_ms: 0.0,
            warm_total_ms: 0.0,
        })
    }

    fn set_text_runs(
        &mut self,
        runs: Vec<TextRunOptions>,
        custom_fonts: &[(String, Vec<u8>)],
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
    ) -> std::result::Result<TextPreparationStats, String> {
        let total_started = Instant::now();
        let text_run_options = runs.clone();
        if self.font_system.is_none() {
            let font_init_started = Instant::now();
            self.font_system = Some(create_font_system());
            self.system_font_init_ms = font_init_started.elapsed().as_secs_f64() * 1000.0;
        }
        let font_system = self.font_system.as_mut().expect("font system initialized");
        let font_load_started = Instant::now();
        for (family, data) in custom_fonts {
            if self.loaded_custom_fonts.insert(family.clone()) {
                font_system.db_mut().load_font_data(data.clone());
            }
        }
        let custom_font_load_ms = font_load_started.elapsed().as_secs_f64() * 1000.0;
        let shaping_started = Instant::now();
        let mut glyph_count = 0_u32;
        let mut line_count = 0_u32;
        let height = height as f32;
        let mut positioned = Vec::with_capacity(runs.len());

        for run in runs {
            let [x, y, run_width, font_size, line_height] =
                [run.x, run.y, run.width, run.font_size, run.line_height];
            if [x, y, run_width, font_size, line_height]
                .iter()
                .any(|value| !value.is_finite())
                || run_width < 0.0
                || font_size <= 0.0
                || line_height <= 0.0
                || run_width > f32::MAX as f64
                || font_size > f32::MAX as f64
                || line_height > f32::MAX as f64
            {
                return Err("text run geometry and font metrics must be finite; width must be nonnegative and font size/line height positive".into());
            }
            let color = parse_text_color(&run.color)
                .ok_or_else(|| format!("invalid text color: {}", run.color))?;
            let mut buffer =
                TextBuffer::new_empty(Metrics::new(font_size as f32, line_height as f32));
            buffer.set_wrap(
                font_system,
                if run.wrap == Some(false) {
                    Wrap::None
                } else {
                    Wrap::Word
                },
            );
            buffer.set_size(font_system, Some((run_width as f32).max(1.0)), None);
            buffer.set_text(
                font_system,
                &run.text,
                Attrs::new()
                    .family(text_family(run.font_family.as_deref()))
                    .weight(Weight(run.font_weight.unwrap_or(400))),
                Shaping::Advanced,
            );
            for layout_run in buffer.layout_runs() {
                line_count += 1;
                glyph_count += layout_run.glyphs.len() as u32;
            }
            positioned.push(PositionedText {
                buffer,
                x: x as f32,
                y: y as f32,
                color,
            });
        }
        let shaping_ms = shaping_started.elapsed().as_secs_f64() * 1000.0;

        let prepare_started = Instant::now();
        self.text_buffers = positioned;
        self.text_run_options = text_run_options;
        self.prepare_text_areas(device, queue, width, height as u32)?;
        let atlas_prepare_ms = prepare_started.elapsed().as_secs_f64() * 1000.0;

        Ok(TextPreparationStats {
            system_font_init_ms: self.system_font_init_ms,
            custom_font_load_ms,
            glyph_count,
            line_count,
            shaping_ms,
            atlas_prepare_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            warm_shaping_ms: 0.0,
            warm_atlas_prepare_ms: 0.0,
            warm_total_ms: 0.0,
        })
    }
}

fn cosmic_cursor_at_char(buffer: &TextBuffer, char_index: usize) -> glyphon::Cursor {
    let mut remaining = char_index;
    for (line_index, line) in buffer.lines.iter().enumerate() {
        let line_char_count = line.text().chars().count();
        if remaining <= line_char_count {
            let byte_index = line
                .text()
                .char_indices()
                .nth(remaining)
                .map(|(byte_index, _)| byte_index)
                .unwrap_or(line.text().len());
            return glyphon::Cursor::new(line_index, byte_index);
        }
        remaining = remaining.saturating_sub(line_char_count + 1);
    }
    glyphon::Cursor::new(
        buffer.lines.len().saturating_sub(1),
        buffer
            .lines
            .last()
            .map(|line| line.text().len())
            .unwrap_or(0),
    )
}

fn cosmic_cursor_x(cursor: glyphon::Cursor, run: &glyphon::LayoutRun<'_>) -> Option<f32> {
    if cursor.line != run.line_i {
        return None;
    }
    for glyph in run.glyphs {
        if cursor.index == glyph.start {
            return Some(if glyph.level.is_rtl() {
                glyph.x + glyph.w
            } else {
                glyph.x
            });
        }
        if cursor.index > glyph.start && cursor.index < glyph.end {
            let cluster = run.text.get(glyph.start..glyph.end)?;
            let mut before = 0;
            let mut total = 0;
            for (offset, _) in cluster.char_indices() {
                if glyph.start + offset < cursor.index {
                    before += 1;
                }
                total += 1;
            }
            let offset = glyph.w * before as f32 / total.max(1) as f32;
            return Some(if glyph.level.is_rtl() {
                glyph.x + glyph.w - offset
            } else {
                glyph.x + offset
            });
        }
    }
    Some(run.glyphs.last().map_or(0.0, |glyph| {
        if glyph.level.is_rtl() {
            glyph.x
        } else {
            glyph.x + glyph.w
        }
    }))
}

impl Renderer {
    fn textarea_geometry(
        &self,
        text: &str,
        selection_start: u32,
        selection_end: u32,
        caret_index: u32,
    ) -> Option<(f64, f64, f64, Vec<TextSelectionRect>)> {
        let runtime = self.text_runtime.as_ref()?;
        let positioned = runtime.text_buffers.iter().find(|positioned| {
            positioned
                .buffer
                .lines
                .iter()
                .map(|line| line.text())
                .collect::<Vec<_>>()
                .join("\n")
                == text
        })?;
        let buffer = &positioned.buffer;
        let start = cosmic_cursor_at_char(buffer, selection_start as usize);
        let selection_end = cosmic_cursor_at_char(buffer, selection_end as usize);
        let caret_cursor = cosmic_cursor_at_char(buffer, caret_index as usize);
        let mut caret = None;
        let mut selection_rects = Vec::new();
        for run in buffer.layout_runs() {
            if let Some(x) = cosmic_cursor_x(caret_cursor, &run) {
                caret = Some((
                    (positioned.x + x) as f64,
                    (positioned.y + run.line_top) as f64,
                    run.line_height as f64,
                ));
            }
            if start < selection_end && run.line_i >= start.line && run.line_i <= selection_end.line
            {
                let run_start = if run.line_i == start.line {
                    start
                } else {
                    glyphon::Cursor::new(run.line_i, 0)
                };
                let run_end = if run.line_i == selection_end.line {
                    selection_end
                } else {
                    glyphon::Cursor::new(run.line_i, buffer.lines[run.line_i].text().len())
                };
                if let Some((x, width)) = run.highlight(run_start, run_end) {
                    if width > 0.0 {
                        selection_rects.push(TextSelectionRect {
                            x: (positioned.x + x) as f64,
                            y: (positioned.y + run.line_top) as f64,
                            width: width as f64,
                            height: run.line_height as f64,
                        });
                    }
                }
            }
        }
        let (caret_x, caret_y, caret_height) = caret?;
        Some((caret_x, caret_y, caret_height, selection_rects))
    }
}

fn parse_text_color(value: &str) -> Option<TextColor> {
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

#[derive(Default)]
struct WindowApp {
    title: String,
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
    max_width: Option<f64>,
    max_height: Option<f64>,
    body_transparent: bool,
    visible: bool,
    resizable: String,
    orientation: String,
    borderless: bool,
    drag_anywhere: Option<String>,
    drag_key_down: bool,
    drag_active: bool,
    left_mouse_down: bool,
    last_drag_click: Option<(Instant, f64, f64)>,
    maximizable: bool,
    maximized: bool,
    vsync: bool,
    window: Option<Arc<OsWindow>>,
    renderer: Option<Renderer>,
    text_editor: Option<TextEditor>,
    error: Option<String>,
    events: Vec<NativeEvent>,
    cursor: (f64, f64),
    cursor_icon: Option<CursorIcon>,
    modifiers: ModifiersState,
    display_list: Vec<f32>,
    display_triangles: Vec<f32>,
    display_circles: Vec<f32>,
    display_beziers: Vec<f32>,
    image_draws: Vec<ImageDraw>,
    draw_order: Vec<DrawOrder>,
    render_pending: bool,
    closed: bool,
    last_render_ms: f64,
    last_prepare_ms: f64,
    last_acquire_ms: f64,
    last_submit_ms: f64,
    last_present_ms: f64,
    last_render_count: u64,
}

impl ApplicationHandler for WindowApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() || self.closed {
            return;
        }
        let attributes = OsWindow::default_attributes()
            .with_title(self.title.clone())
            .with_visible(self.visible)
            .with_resizable(self.resizable != "none")
            .with_decorations(!self.borderless)
            .with_transparent(self.borderless || self.body_transparent)
            .with_maximized(self.maximized)
            .with_inner_size(LogicalSize::new(self.width, self.height));
        match event_loop.create_window(attributes) {
            Ok(window) => {
                let window = Arc::new(window);
                match Renderer::new(window.clone(), self.borderless || self.body_transparent, self.vsync) {
                    Ok(renderer) => {
                        self.text_editor = Some(TextEditor::new(window.as_ref()));
                        self.apply_resizable(&window);
                        self.window = Some(window);
                        self.renderer = Some(renderer);
                    }
                    Err(error) => {
                        eprintln!("Nasty: could not initialize renderer: {error}");
                        self.error = Some(error);
                    }
                }
            }
            Err(error) => self.error = Some(format!("create native window: {error}")),
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: OsWindowEvent,
    ) {
        if self.window.as_ref().map(|window| window.id()) != Some(window_id) {
            return;
        }
        if let (Some(window), Some(editor)) = (self.window.as_ref(), self.text_editor.as_mut()) {
            editor.on_window_event(window, &event);
        }
        match event {
            OsWindowEvent::CloseRequested => {
                self.closed = true;
                self.window = None;
                self.renderer = None;
                self.text_editor = None;
                event_loop.exit();
            }
            OsWindowEvent::Resized(size) => {
                if let Some(renderer) = self.renderer.as_mut() {
                    renderer.resize(size.width, size.height);
                }
                self.events.push(NativeEvent {
                    kind: "resize".into(),
                    x: size.width as f64,
                    y: size.height as f64,
                    key: None,
                    button: None,
                    text: None,
                    modifiers: None,
                    delta_x: None,
                    delta_y: None,
                });
            }
            OsWindowEvent::Moved(_) => {
                if let Some(rate) = self
                    .window
                    .as_ref()
                    .and_then(|window| window.current_monitor())
                    .and_then(|monitor| monitor.refresh_rate_millihertz())
                    .filter(|rate| *rate > 0)
                {
                    self.events.push(NativeEvent {
                        kind: "refreshRate".into(),
                        x: rate as f64 / 1000.0,
                        y: 0.0,
                        key: None,
                        button: None,
                        text: None,
                        modifiers: None,
                        delta_x: None,
                        delta_y: None,
                    });
                }
            }
            OsWindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
                if let Some(window) = self.window.as_ref() {
                    let scale = window.scale_factor();
                    let logical_size = window.inner_size().to_logical::<f64>(scale);
                    let direction = resize_direction(
                        &self.resizable,
                        position.x / scale,
                        position.y / scale,
                        logical_size.width,
                        logical_size.height,
                    );
                    let cursor = if self.drag_active {
                        CursorIcon::Grabbing
                    } else if self.drag_key_is_down() {
                        CursorIcon::Grab
                    } else {
                        direction.map(CursorIcon::from).unwrap_or(CursorIcon::Default)
                    };
                    if self.cursor_icon != Some(cursor) {
                        window.set_cursor(cursor);
                        self.cursor_icon = Some(cursor);
                    }
                }
                if self.drag_key_is_down() || self.drag_active { return; }
                self.events.push(NativeEvent {
                    kind: "pointermove".into(),
                    x: position.x,
                    y: position.y,
                    key: None,
                    button: None,
                    text: None,
                    modifiers: None,
                    delta_x: None,
                    delta_y: None,
                });
            }
            OsWindowEvent::CursorLeft { .. } => {
                if !self.drag_key_is_down() && !self.drag_active {
                    if let Some(window) = self.window.as_ref() {
                        if self.cursor_icon != Some(CursorIcon::Default) {
                            window.set_cursor(CursorIcon::Default);
                            self.cursor_icon = Some(CursorIcon::Default);
                        }
                    }
                }
            }
            OsWindowEvent::MouseInput { state, button, .. } => {
                if button == MouseButton::Left {
                    self.left_mouse_down = state.is_pressed();
                }
                let drag_key_down = self.drag_key_is_down();
                if button == MouseButton::Left && (drag_key_down || self.drag_active) {
                    if state == ElementState::Pressed {
                        let now = Instant::now();
                        let double_click = self.last_drag_click.is_some_and(|(at, x, y)| {
                            now.duration_since(at) <= Duration::from_millis(500)
                                && (self.cursor.0 - x).hypot(self.cursor.1 - y) <= 8.0
                        });
                        if double_click {
                            self.last_drag_click = None;
                            if self.maximizable {
                                if let Some(window) = self.window.as_ref() {
                                    let maximized = !window.is_maximized();
                                    window.set_maximized(maximized);
                                    self.maximized = maximized;
                                }
                            }
                        } else {
                            self.last_drag_click = Some((now, self.cursor.0, self.cursor.1));
                            if let Some(window) = self.window.as_ref() { let _ = window.drag_window(); }
                            self.drag_active = true;
                        }
                    } else {
                        self.drag_active = false;
                    }
                    return;
                }
                if drag_key_down { return; }
                if state == ElementState::Pressed && button == MouseButton::Left {
                    if let Some(window) = self.window.as_ref() {
                        let scale = window.scale_factor();
                        let logical_size = window.inner_size().to_logical::<f64>(scale);
                        let direction = resize_direction(
                            &self.resizable,
                            self.cursor.0 / scale,
                            self.cursor.1 / scale,
                            logical_size.width,
                            logical_size.height,
                        );
                        if let Some(direction) = direction {
                            if window.drag_resize_window(direction).is_ok() {
                                return;
                            }
                        }
                    }
                }
                self.events.push(NativeEvent {
                    kind: if state.is_pressed() { "pointerdown" } else { "pointerup" }.into(),
                    x: self.cursor.0,
                    y: self.cursor.1,
                    key: None,
                    button: Some(match button { MouseButton::Left => 0, MouseButton::Middle => 1, MouseButton::Right => 2, MouseButton::Back => 3, MouseButton::Forward => 4, MouseButton::Other(id) => u32::from(id) }),
                    text: None,
                    modifiers: None,
                    delta_x: None,
                    delta_y: None,
                });
            }
            OsWindowEvent::MouseWheel { delta, .. } => {
                if self.drag_key_is_down() || self.drag_active { return; }
                let (delta_x, delta_y) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (x as f64 * 40.0, y as f64 * 40.0),
                    MouseScrollDelta::PixelDelta(position) => (position.x, position.y),
                };
                self.events.push(NativeEvent {
                    kind: "wheel".into(),
                    x: self.cursor.0,
                    y: self.cursor.1,
                    key: None,
                    button: None,
                    text: None,
                    modifiers: None,
                    delta_x: Some(delta_x),
                    delta_y: Some(delta_y),
                });
            }
            OsWindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
                self.update_drag_cursor();
            }
            OsWindowEvent::KeyboardInput { event, .. } => {
                if let Some(configured) = self.drag_anywhere.as_deref() {
                    if configured != "*" && !matches!(configured, "Ctrl" | "Shift" | "Alt" | "Meta") {
                        let key = format!("{:?}", event.logical_key);
                        if key_matches(configured, &key, event.logical_key.to_text()) {
                            self.drag_key_down = event.state.is_pressed();
                        }
                    }
                }
                self.update_drag_cursor();
                self.events.push(NativeEvent {
                kind: if event.state.is_pressed() {
                    "keydown"
                } else {
                    "keyup"
                }
                .into(),
                x: self.cursor.0,
                y: self.cursor.1,
                key: Some(format!("{:?}", event.logical_key)),
                button: None,
                text: event.text.map(|text| text.to_string()),
                modifiers: Some(format!("{:?}", self.modifiers)),
                delta_x: None,
                delta_y: None,
            })
            }
            OsWindowEvent::Ime(ime) => {
                let (kind, text, cursor) = match ime {
                    Ime::Enabled => ("imeEnabled", None, None),
                    Ime::Preedit(text, cursor) => ("imePreedit", Some(text), cursor),
                    Ime::Commit(text) => ("imeCommit", Some(text), None),
                    Ime::Disabled => ("imeDisabled", None, None),
                };
                self.events.push(NativeEvent {
                    kind: kind.into(),
                    x: cursor.map(|range| range.0 as f64).unwrap_or(-1.0),
                    y: cursor.map(|range| range.1 as f64).unwrap_or(-1.0),
                    key: None,
                    button: None,
                    text,
                    modifiers: None,
                    delta_x: None,
                    delta_y: None,
                });
            }
            OsWindowEvent::RedrawRequested if self.render_pending => {
                self.render_pending = false;
                let Some(window) = self.window.as_ref() else {
                    return;
                };
                let Some(renderer) = self.renderer.as_mut() else {
                    return;
                };
                match renderer.render(
                    window,
                    &self.display_list,
                    &self.display_triangles,
                    &self.display_circles,
                    &self.display_beziers,
                    &self.image_draws,
                    &self.draw_order,
                ) {
                    Ok(timings) => {
                        self.last_render_ms = timings.total_ms;
                        self.last_prepare_ms = timings.prepare_ms;
                        self.last_acquire_ms = timings.acquire_ms;
                        self.last_submit_ms = timings.submit_ms;
                        self.last_present_ms = timings.present_ms;
                    }
                    Err(error) => self.error = Some(error),
                }
                self.last_render_count += 1;
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
    }
}

impl WindowApp {
    fn drag_key_is_down(&self) -> bool {
        match self.drag_anywhere.as_deref() {
            None => false,
            Some("*") => true,
            Some(key) if key.eq_ignore_ascii_case("ctrl") || key.eq_ignore_ascii_case("control") => self.modifiers.control_key(),
            Some(key) if key.eq_ignore_ascii_case("shift") => self.modifiers.shift_key(),
            Some(key) if key.eq_ignore_ascii_case("alt") => self.modifiers.alt_key(),
            Some(key) if key.eq_ignore_ascii_case("meta") || key.eq_ignore_ascii_case("super") => self.modifiers.super_key(),
            Some(_) => self.drag_key_down,
        }
    }

    fn update_drag_cursor(&mut self) {
        if self.drag_key_is_down() && self.left_mouse_down && !self.drag_active {
            if let Some(window) = self.window.as_ref() { let _ = window.drag_window(); }
            self.drag_active = true;
        }
        let Some(window) = self.window.as_ref() else { return; };
        let scale = window.scale_factor();
        let size = window.inner_size().to_logical::<f64>(scale);
        let cursor = if self.drag_active {
            CursorIcon::Grabbing
        } else if self.drag_key_is_down() {
            CursorIcon::Grab
        } else {
            resize_direction(&self.resizable, self.cursor.0 / scale, self.cursor.1 / scale, size.width, size.height)
                .map(CursorIcon::from).unwrap_or(CursorIcon::Default)
        };
        if self.cursor_icon != Some(cursor) {
            window.set_cursor(cursor);
            self.cursor_icon = Some(cursor);
        }
    }

    fn apply_resizable(&self, window: &OsWindow) {
        window.set_min_inner_size::<LogicalSize<f64>>(None);
        window.set_max_inner_size::<LogicalSize<f64>>(None);
        let scale = window.scale_factor();
        let size = window.inner_size().to_logical::<f64>(scale);
        let (min_width, min_height, max_width, max_height) = match self.resizable.as_str() {
            "none" => { window.set_resizable(false); return; }
            "both" => (self.min_width, self.min_height, self.max_width, self.max_height),
            "horizontal" => {
                window.set_resizable(true);
                (self.min_width, Some(size.height), self.max_width, Some(size.height))
            }
            "vertical" => {
                window.set_resizable(true);
                (Some(size.width), self.min_height, Some(size.width), self.max_height)
            }
            _ => unreachable!("resizable mode validated in constructor and setter"),
        };
        if min_width.is_some() || min_height.is_some() {
            window.set_min_inner_size(Some(LogicalSize::new(min_width.unwrap_or(1.0).max(1.0), min_height.unwrap_or(1.0).max(1.0))));
        }
        if max_width.is_some() || max_height.is_some() {
            window.set_max_inner_size(Some(LogicalSize::new(
                max_width.unwrap_or(i32::MAX as f64).max(1.0),
                max_height.unwrap_or(i32::MAX as f64).max(1.0),
            )));
        }
        let upper_width = max_width.unwrap_or(i32::MAX as f64).max(1.0);
        let upper_height = max_height.unwrap_or(i32::MAX as f64).max(1.0);
        let bounded = LogicalSize::new(
            size.width.clamp(min_width.unwrap_or(1.0).max(1.0), upper_width),
            size.height.clamp(min_height.unwrap_or(1.0).max(1.0), upper_height),
        );
        if (bounded.width - size.width).abs() > 0.5 || (bounded.height - size.height).abs() > 0.5 {
            let _ = window.request_inner_size(bounded);
        }
    }

    fn apply_transparency(&mut self) {
        let transparent = self.borderless || self.body_transparent;
        if let Some(window) = self.window.as_ref() {
            window.set_transparent(transparent);
            if let Some(renderer) = self.renderer.as_mut() {
                renderer.set_transparent(window, transparent);
            }
            self.render_pending = true;
        }
    }
}

fn key_matches(configured: &str, debug_key: &str, text: Option<&str>) -> bool {
    let configured = configured.trim();
    configured.eq_ignore_ascii_case(debug_key)
        || text.is_some_and(|text| configured.eq_ignore_ascii_case(text))
}

fn resize_direction(
    mode: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Option<ResizeDirection> {
    let horizontal = matches!(mode, "horizontal" | "both");
    let vertical = matches!(mode, "vertical" | "both");
    if !horizontal && !vertical {
        return None;
    }

    // Use a small logical-pixel strip inside the client area as a resize handle.
    // The compositor performs the actual drag, so resizing never depends on a
    // JavaScript pointer-move loop or repeated set_inner_size calls.
    const EDGE: f64 = 12.0;
    let left = horizontal && x < EDGE;
    let right = horizontal && x >= width - EDGE;
    let top = vertical && y < EDGE;
    let bottom = vertical && y >= height - EDGE;
    Some(match (left, right, top, bottom) {
        (true, _, true, _) => ResizeDirection::NorthWest,
        (_, true, true, _) => ResizeDirection::NorthEast,
        (true, _, _, true) => ResizeDirection::SouthWest,
        (_, true, _, true) => ResizeDirection::SouthEast,
        (true, _, _, _) => ResizeDirection::West,
        (_, true, _, _) => ResizeDirection::East,
        (_, _, true, _) => ResizeDirection::North,
        (_, _, _, true) => ResizeDirection::South,
        _ => return None,
    })
}

#[napi]
pub struct Window {
    event_loop: EventLoop<()>,
    app: WindowApp,
}

#[napi]
impl Window {
    #[napi(constructor)]
    pub fn new(options: WindowOptions) -> Result<Self> {
        let mut builder = EventLoop::builder();
        #[cfg(target_os = "android")]
        {
            use winit::platform::android::EventLoopBuilderExtAndroid;
            let android_app = ANDROID_APP.get().cloned().ok_or_else(|| {
                Error::new(Status::GenericFailure, "Android app host is not initialized")
            })?;
            builder.with_android_app(android_app);
        }
        if options.allow_any_thread.unwrap_or(false) {
            #[cfg(target_os = "linux")]
            winit::platform::wayland::EventLoopBuilderExtWayland::with_any_thread(
                &mut builder,
                true,
            );
            #[cfg(target_os = "windows")]
            winit::platform::windows::EventLoopBuilderExtWindows::with_any_thread(
                &mut builder,
                true,
            );
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            return Err(Error::new(
                Status::InvalidArg,
                "worker-owned windows are unsupported on this platform",
            ));
        }
        let event_loop = builder.build().map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("create event loop: {error}"),
            )
        })?;
        let resizable = options.resizable.unwrap_or_else(|| "both".into());
        if !matches!(
            resizable.as_str(),
            "horizontal" | "vertical" | "both" | "none"
        ) {
            return Err(Error::new(
                Status::InvalidArg,
                "resizable must be horizontal, vertical, both, or none",
            ));
        }
        let orientation = options.orientation.unwrap_or_else(|| "auto".into());
        if !matches!(orientation.as_str(), "auto" | "portrait" | "landscape") {
            return Err(Error::new(
                Status::InvalidArg,
                "orientation must be auto, portrait, or landscape",
            ));
        }
        let app = WindowApp {
            title: options.title.unwrap_or_else(|| "Nasty".into()),
            width: options.width.unwrap_or(960.0),
            height: options.height.unwrap_or(600.0),
            visible: options.visible.unwrap_or(true),
            resizable,
            orientation,
            borderless: options.borderless.unwrap_or(false),
            drag_anywhere: match options.drag_anywhere {
                None | Some(Either::A(false)) => None,
                Some(Either::A(true)) => Some("*".into()),
                Some(Either::B(key)) if !key.trim().is_empty() => Some(key),
                Some(Either::B(_)) => return Err(Error::new(Status::InvalidArg, "dragAnywhere key must not be empty")),
            },
            maximizable: options.maximizable.unwrap_or(false),
            maximized: options.maximized.unwrap_or(false),
            vsync: options.vsync.unwrap_or(true),
            ..Default::default()
        };
        if !app.width.is_finite() || !app.height.is_finite() || app.width < 1.0 || app.height < 1.0
        {
            return Err(Error::new(
                Status::InvalidArg,
                "window width and height must be positive finite numbers",
            ));
        }
        let mut window = Self { event_loop, app };
        window.apply_orientation()?;
        window.pump(Duration::ZERO)?;
        #[cfg(target_os = "android")]
        {
            let deadline = Instant::now() + Duration::from_secs(5);
            while window.app.renderer.is_none()
                && window.app.error.is_none()
                && !window.app.closed
                && Instant::now() < deadline
            {
                window.pump(Duration::from_millis(16))?;
            }
            if window.app.renderer.is_none() && window.app.error.is_none() {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Android window did not finish initializing its renderer",
                ));
            }
        }
        window.check_error()?;
        Ok(window)
    }

    #[napi]
    pub fn show(&self) -> Result<()> {
        let window =
            self.app.window.as_ref().ok_or_else(|| {
                Error::new(Status::GenericFailure, "native window is unavailable")
            })?;
        window.set_visible(true);
        window.request_redraw();
        Ok(())
    }

    #[napi(js_name = "setResizableMode")]
    pub fn set_resizable_mode(&mut self, mode: String) -> Result<()> {
        if !matches!(mode.as_str(), "horizontal" | "vertical" | "both" | "none") {
            return Err(Error::new(
                Status::InvalidArg,
                "resizable must be horizontal, vertical, both, or none",
            ));
        }
        self.app.resizable = mode;
        if let Some(window) = self.app.window.as_ref() {
            self.app.apply_resizable(window);
        }
        Ok(())
    }

    #[napi(js_name = "resizableMode")]
    pub fn resizable_mode(&self) -> String {
        self.app.resizable.clone()
    }

    #[napi(js_name = "setBorderless")]
    pub fn set_borderless(&mut self, value: bool) -> Result<()> {
        self.app.borderless = value;
        if let Some(window) = self.app.window.as_ref() {
            window.set_decorations(!value);
        }
        self.app.apply_transparency();
        Ok(())
    }

    #[napi(js_name = "setBodyTransparency")]
    pub fn set_body_transparency(&mut self, value: bool) {
        self.app.body_transparent = value;
        self.app.apply_transparency();
    }

    #[napi(js_name = "setDragAnywhere")]
    pub fn set_drag_anywhere(&mut self, value: Either<bool, String>) -> Result<()> {
        let configured = match value {
            Either::A(false) => None,
            Either::A(true) => Some("*".into()),
            Either::B(key) if !key.trim().is_empty() => Some(key),
            Either::B(_) => return Err(Error::new(Status::InvalidArg, "dragAnywhere key must not be empty")),
        };
        self.app.drag_anywhere = configured;
        self.app.drag_key_down = false;
        self.app.drag_active = false;
        self.app.left_mouse_down = false;
        self.app.update_drag_cursor();
        Ok(())
    }

    #[napi(js_name = "setVsync")]
    pub fn set_vsync(&mut self, value: bool) -> Result<()> {
        if let Some(renderer) = self.app.renderer.as_mut() {
            renderer.set_vsync(value).map_err(|error| Error::new(Status::GenericFailure, error))?;
        }
        self.app.vsync = value;
        Ok(())
    }

    #[napi(js_name = "setMaximizable")]
    pub fn set_maximizable(&mut self, value: bool) {
        self.app.maximizable = value;
    }

    #[napi(js_name = "setMaximized")]
    pub fn set_maximized(&mut self, value: bool) -> Result<()> {
        self.app.maximized = value;
        if let Some(window) = self.app.window.as_ref() {
            window.set_maximized(value);
        }
        Ok(())
    }

    #[napi(js_name = "isMaximized")]
    pub fn is_maximized(&self) -> bool {
        self.app.maximized
    }

    #[napi]
    pub fn start_dragging(&self) -> Result<()> {
        if self.app.drag_anywhere.is_none() { return Ok(()); }
        let window = self.app.window.as_ref().ok_or_else(|| Error::new(Status::GenericFailure, "native window is unavailable"))?;
        window.drag_window().map_err(|error| Error::new(Status::GenericFailure, format!("start window drag: {error}")))
    }

    #[napi]
    pub fn toggle_maximize(&mut self) -> Result<()> {
        if !self.app.maximizable { return Ok(()); }
        let window = self.app.window.as_ref().ok_or_else(|| Error::new(Status::GenericFailure, "native window is unavailable"))?;
        let maximized = !window.is_maximized();
        window.set_maximized(maximized);
        self.app.maximized = maximized;
        Ok(())
    }

    #[napi(js_name = "setSizeConstraints")]
    pub fn set_size_constraints(
        &mut self,
        min_width: Option<f64>,
        min_height: Option<f64>,
        max_width: Option<f64>,
        max_height: Option<f64>,
    ) -> Result<()> {
        for (name, value) in [("minWidth", min_width), ("minHeight", min_height), ("maxWidth", max_width), ("maxHeight", max_height)] {
            if value.is_some_and(|value| !value.is_finite() || value < 0.0) {
                return Err(Error::new(Status::InvalidArg, format!("{name} must be a finite nonnegative number")));
            }
        }
        if min_width.unwrap_or(1.0).max(1.0) > max_width.unwrap_or(i32::MAX as f64).max(1.0)
            || min_height.unwrap_or(1.0).max(1.0) > max_height.unwrap_or(i32::MAX as f64).max(1.0)
        {
            return Err(Error::new(Status::InvalidArg, "minimum window dimensions cannot exceed maximum dimensions"));
        }
        self.app.min_width = min_width;
        self.app.min_height = min_height;
        self.app.max_width = max_width;
        self.app.max_height = max_height;
        if let Some(window) = self.app.window.as_ref() {
            self.app.apply_resizable(window);
            let size = window.inner_size().to_logical::<f64>(window.scale_factor());
            let bounded = LogicalSize::new(
                size.width.clamp(min_width.unwrap_or(1.0).max(1.0), max_width.unwrap_or(i32::MAX as f64).max(1.0)),
                size.height.clamp(min_height.unwrap_or(1.0).max(1.0), max_height.unwrap_or(i32::MAX as f64).max(1.0)),
            );
            if (bounded.width - size.width).abs() > 0.5 || (bounded.height - size.height).abs() > 0.5 {
                let _ = window.request_inner_size(bounded);
            }
            window.request_redraw();
            self.app.render_pending = true;
        }
        for _ in 0..8 {
            self.pump(Duration::from_millis(4))?;
            self.check_error()?;
            let Some(window) = self.app.window.as_ref() else { break; };
            let size = window.inner_size().to_logical::<f64>(window.scale_factor());
            let min_width = self.app.min_width.unwrap_or(1.0).max(1.0);
            let min_height = self.app.min_height.unwrap_or(1.0).max(1.0);
            let max_width = self.app.max_width.unwrap_or(i32::MAX as f64).max(1.0);
            let max_height = self.app.max_height.unwrap_or(i32::MAX as f64).max(1.0);
            if size.width >= min_width - 0.5 && size.height >= min_height - 0.5
                && size.width <= max_width + 0.5 && size.height <= max_height + 0.5 { break; }
        }
        Ok(())
    }

    fn apply_orientation(&self) -> Result<()> {
        #[cfg(target_os = "android")]
        {
            let orientation = match self.app.orientation.as_str() {
                "auto" => -1,
                "landscape" => 0,
                "portrait" => 1,
                _ => unreachable!("orientation mode validated in constructor and setter"),
            };
            let result = unsafe { nasty_set_requested_orientation(orientation) };
            if result != 0 {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Android could not change the requested screen orientation",
                ));
            }
        }
        Ok(())
    }

    #[napi(js_name = "setOrientationMode")]
    pub fn set_orientation_mode(&mut self, mode: String) -> Result<()> {
        if !matches!(mode.as_str(), "auto" | "portrait" | "landscape") {
            return Err(Error::new(
                Status::InvalidArg,
                "orientation must be auto, portrait, or landscape",
            ));
        }
        self.app.orientation = mode;
        self.apply_orientation()
    }

    #[napi(js_name = "orientationMode")]
    pub fn orientation_mode(&self) -> String {
        self.app.orientation.clone()
    }

    #[napi]
    pub fn size(&self) -> WindowSize {
        let size = self
            .app
            .window
            .as_ref()
            .map(|window| window.inner_size())
            .unwrap_or_default();
        WindowSize {
            width: size.width,
            height: size.height,
        }
    }

    #[napi(js_name = "displaySize")]
    pub fn display_size(&self) -> DisplaySize {
        let Some(window) = self.app.window.as_ref() else {
            return DisplaySize { width: 960.0, height: 600.0, scale_factor: 1.0 };
        };
        let scale_factor = window.scale_factor();
        let size = window.current_monitor()
            .map(|monitor| monitor.size().to_logical::<f64>(scale_factor))
            .unwrap_or_else(|| window.inner_size().to_logical::<f64>(scale_factor));
        DisplaySize { width: size.width, height: size.height, scale_factor }
    }

    #[napi(js_name = "setSize")]
    pub fn set_size(&mut self, width: f64, height: f64) -> Result<()> {
        if !width.is_finite() || !height.is_finite() || width < 0.0 || height < 0.0 {
            return Err(Error::new(Status::InvalidArg, "window width and height must be finite nonnegative numbers"));
        }
        let min_width = self.app.min_width.unwrap_or(1.0).max(1.0);
        let min_height = self.app.min_height.unwrap_or(1.0).max(1.0);
        let max_width = self.app.max_width.unwrap_or(i32::MAX as f64).max(1.0);
        let max_height = self.app.max_height.unwrap_or(i32::MAX as f64).max(1.0);
        let width = width.clamp(min_width, max_width);
        let height = height.clamp(min_height, max_height);
        self.app.width = width;
        self.app.height = height;
        let window = self.app.window.as_ref().ok_or_else(|| Error::new(Status::GenericFailure, "native window is unavailable"))?;
        let _ = window.request_inner_size(LogicalSize::new(width, height));
        window.request_redraw();
        self.app.render_pending = true;
        self.pump(Duration::from_millis(2))?;
        self.check_error()
    }

    #[napi]
    pub fn adapter_name(&self) -> String {
        self.app
            .renderer
            .as_ref()
            .map(|renderer| renderer.adapter_name.clone())
            .unwrap_or_default()
    }

    #[napi]
    pub fn surface_format(&self) -> String {
        self.app
            .renderer
            .as_ref()
            .map(|renderer| renderer.format_name.clone())
            .unwrap_or_default()
    }

    #[napi]
    pub fn present_mode(&self) -> String {
        self.app
            .renderer
            .as_ref()
            .map(|renderer| renderer.present_mode_name.clone())
            .unwrap_or_default()
    }

    #[napi(js_name = "requestTextRuns")]
    pub fn request_text_runs(
        &mut self,
        runs: Vec<TextRunOptions>,
        custom_fonts: Option<Vec<TextFontData>>,
    ) -> Result<u32> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let system_font = self.app.text_editor.as_ref().and_then(|editor| {
            Some((
                editor.system_font_family.clone()?,
                editor.system_font_bytes.clone()?,
            ))
        });
        let renderer = self
            .app
            .renderer
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        renderer
            .request_text_runs(runs, custom_fonts.unwrap_or_default(), system_font)
            .map_err(|error| Error::new(Status::InvalidArg, error))
    }

    #[napi(js_name = "setTextRunsNow")]
    pub fn set_text_runs_now(
        &mut self,
        runs: Vec<TextRunOptions>,
        custom_fonts: Option<Vec<TextFontData>>,
        update_run_index: Option<u32>,
    ) -> Result<TextPreparationStats> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let system_font = self.app.text_editor.as_ref().and_then(|editor| {
            Some((
                editor.system_font_family.clone()?,
                editor.system_font_bytes.clone()?,
            ))
        });
        self.app
            .renderer
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?
            .set_text_runs_now(
                runs,
                custom_fonts.unwrap_or_default(),
                system_font,
                update_run_index.map(|index| index as usize),
            )
            .map_err(|error| Error::new(Status::GenericFailure, error))
    }

    #[napi(js_name = "textAreaGeometry")]
    pub fn text_area_geometry(
        &self,
        text: String,
        selection_start: u32,
        selection_end: u32,
        caret_index: u32,
    ) -> Option<TextAreaGeometry> {
        self.app.renderer.as_ref()?.textarea_geometry_for_api(
            &text,
            selection_start,
            selection_end,
            caret_index,
        )
    }

    // Internal compositor transport: reuse shaped buffers for paint-only changes.
    #[napi(js_name = "updateTextPlacement")]
    pub fn update_text_placement(
        &mut self,
        runs: Vec<TextRunOptions>,
        update_indices: Option<Vec<u32>>,
    ) -> Result<()> {
        let renderer = self
            .app
            .renderer
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        let runtime = renderer
            .text_runtime
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "text runtime unavailable"))?;
        if update_indices.is_none() && runs.len() != runtime.text_buffers.len() {
            return Err(Error::new(
                Status::InvalidArg,
                "text placement count mismatch",
            ));
        }
        let indices = update_indices.unwrap_or_else(|| (0..runs.len() as u32).collect());
        if runs.len() != indices.len() {
            return Err(Error::new(
                Status::InvalidArg,
                "sparse text placement count mismatch",
            ));
        }
        if indices
            .iter()
            .any(|index| *index as usize >= runtime.text_buffers.len())
        {
            return Err(Error::new(
                Status::InvalidArg,
                "text placement index out of range",
            ));
        }
        for (run, index) in runs.iter().zip(&indices) {
            let old = &runtime.text_run_options[*index as usize];
            if run.text != old.text
                || run.width != old.width
                || run.font_size != old.font_size
                || run.line_height != old.line_height
                || run.font_family != old.font_family
                || run.wrap != old.wrap
                || !run.x.is_finite()
                || !run.y.is_finite()
                || parse_text_color(&run.color).is_none()
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "placement must preserve shaped text and use valid geometry/color",
                ));
            }
        }
        for (run, index) in runs.iter().zip(indices) {
            let index = index as usize;
            let text = &mut runtime.text_buffers[index];
            text.x = run.x as f32;
            text.y = run.y as f32;
            text.color = parse_text_color(&run.color).unwrap();
            runtime.text_run_options[index] = run.clone();
        }
        runtime
            .prepare_text_areas(
                &renderer.device,
                &renderer.queue,
                renderer.config.width,
                renderer.config.height,
            )
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
        Ok(())
    }

    #[napi(js_name = "pollTextRuns")]
    pub fn poll_text_runs(&mut self) -> Result<Option<TextPreparationStats>> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let renderer = self
            .app
            .renderer
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        renderer
            .poll_text_runs()
            .map_err(|error| Error::new(Status::GenericFailure, error))
    }

    #[napi(js_name = "systemFontInitMs")]
    pub fn system_font_init_ms(&self) -> f64 {
        self.app
            .renderer
            .as_ref()
            .map(Renderer::system_font_init_ms)
            .unwrap_or(0.0)
    }

    #[napi]
    pub fn refresh_rate(&self) -> f64 {
        self.app
            .window
            .as_ref()
            .and_then(|window| window.current_monitor())
            .and_then(|monitor| monitor.refresh_rate_millihertz())
            .filter(|rate| *rate > 0)
            .map(|rate| rate as f64 / 1000.0)
            .unwrap_or(0.0)
    }

    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.app.closed
    }

    #[napi]
    pub fn close(&mut self) {
        self.app.closed = true;
        self.app.window = None;
        self.app.renderer = None;
    }

    #[napi]
    pub fn drain_events(&mut self) -> Vec<NativeEvent> {
        std::mem::take(&mut self.app.events)
    }

    #[napi(js_name = "setImeAllowed")]
    pub fn set_ime_allowed(&self, allowed: bool) -> Result<()> {
        let window =
            self.app.window.as_ref().ok_or_else(|| {
                Error::new(Status::GenericFailure, "native window is unavailable")
            })?;
        window.set_ime_allowed(allowed);
        Ok(())
    }

    #[napi(js_name = "updateTextArea")]
    pub fn update_text_area(&mut self, options: TextAreaOptions) -> Result<TextAreaState> {
        self.update_text_areas(vec![options])?
            .into_iter()
            .next()
            .ok_or_else(|| Error::new(Status::GenericFailure, "text editor returned no state"))
    }

    #[napi(js_name = "updateTextAreas")]
    pub fn update_text_areas(
        &mut self,
        options: Vec<TextAreaOptions>,
    ) -> Result<Vec<TextAreaState>> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let window =
            self.app.window.as_ref().ok_or_else(|| {
                Error::new(Status::GenericFailure, "native window is unavailable")
            })?;
        let renderer = self.app.renderer.as_ref();
        let editor = self
            .app
            .text_editor
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "text editor is unavailable"))?;
        Ok(editor.update_many(window, options, renderer))
    }

    #[napi]
    pub fn present(&mut self, display_list: Buffer) -> Result<PresentStats> {
        self.present_display_list(display_list, Vec::new())
    }

    #[napi(js_name = "createImageTexture")]
    pub fn create_image_texture(&mut self, width: u32, height: u32, pixels: Buffer) -> Result<u32> {
        let renderer = self
            .app
            .renderer
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        renderer
            .upload_image(width, height, pixels.as_ref())
            .map_err(|error| Error::new(Status::InvalidArg, error))
    }

    #[napi(js_name = "deleteImageTexture")]
    pub fn delete_image_texture(&mut self, texture_id: u32) -> bool {
        self.app
            .renderer
            .as_mut()
            .is_some_and(|renderer| renderer.images.remove(&texture_id).is_some())
    }

    #[napi(js_name = "updateImageTexture")]
    pub fn update_image_texture(&mut self, texture_id: u32, pixels: Buffer) -> Result<()> {
        let renderer = self.app.renderer.as_ref().ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        let image = renderer.images.get(&texture_id).ok_or_else(|| Error::new(Status::InvalidArg, "unknown image texture"))?;
        if pixels.len() != image.width as usize * image.height as usize * 4 {
            return Err(Error::new(Status::InvalidArg, "image update must match the texture dimensions"));
        }
        renderer.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &image._texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            pixels.as_ref(),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(image.width * 4), rows_per_image: Some(image.height) },
            wgpu::Extent3d { width: image.width, height: image.height, depth_or_array_layers: 1 },
        );
        Ok(())
    }

    #[napi(js_name = "updateImageTextureRegion")]
    pub fn update_image_texture_region(
        &mut self,
        texture_id: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: Buffer,
    ) -> Result<()> {
        let renderer = self.app.renderer.as_ref().ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        let image = renderer.images.get(&texture_id).ok_or_else(|| Error::new(Status::InvalidArg, "unknown image texture"))?;
        if width == 0 || height == 0 || x.checked_add(width).is_none_or(|right| right > image.width)
            || y.checked_add(height).is_none_or(|bottom| bottom > image.height)
            || pixels.len() != width as usize * height as usize * 4
        {
            return Err(Error::new(Status::InvalidArg, "image region is outside the texture or has an invalid byte length"));
        }
        // Keep each uploaded row on WGPU's copy alignment. Some GL drivers
        // otherwise reuse the previous unpack row length for narrow regions,
        // leaving a one-pixel stale strip at the dirty rectangle edge.
        let row_bytes = width as usize * 4;
        let padded_row_bytes = row_bytes.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
        let upload = if padded_row_bytes == row_bytes {
            pixels.to_vec()
        } else {
            let mut padded = vec![0; padded_row_bytes * height as usize];
            for row in 0..height as usize {
                let source = &pixels[row * row_bytes..(row + 1) * row_bytes];
                let target = &mut padded[row * padded_row_bytes..row * padded_row_bytes + row_bytes];
                target.copy_from_slice(source);
            }
            padded
        };
        renderer.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &image._texture, mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            &upload,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded_row_bytes as u32), rows_per_image: Some(height) },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        Ok(())
    }

    #[napi(js_name = "presentWithImages")]
    pub fn present_with_images(
        &mut self,
        display_list: Buffer,
        images: Vec<ImageDraw>,
    ) -> Result<PresentStats> {
        self.present_display_list(display_list, images)
    }

    #[napi(js_name = "presentOrdered")]
    pub fn present_ordered(
        &mut self,
        display_list: Buffer,
        canvas_triangles: Option<Buffer>,
        canvas_circles: Option<Buffer>,
        canvas_beziers: Option<Buffer>,
        canvas_operations: Option<Buffer>,
    ) -> Result<PresentStats> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let triangles = canvas_triangles.as_ref().map(|buffer| copy_f32_buffer(buffer.as_ref())).unwrap_or_default();
        let circles = canvas_circles.as_ref().map(|buffer| copy_f32_buffer(buffer.as_ref())).unwrap_or_default();
        let beziers = canvas_beziers.as_ref().map(|buffer| copy_f32_buffer(buffer.as_ref())).unwrap_or_default();
        let operations = canvas_operations.as_ref().map(|buffer| copy_f32_buffer(buffer.as_ref())).unwrap_or_default();
        if canvas_triangles.as_ref().is_some_and(|buffer| buffer.len() % 24 != 0) {
            return Err(Error::new(Status::InvalidArg, "canvas triangle buffer must contain complete vertices"));
        }
        if circles.len() % 16 != 0 || circles.iter().any(|value| !value.is_finite())
            || beziers.len() % 13 != 0 || beziers.iter().any(|value| !value.is_finite())
            || operations.len() % 3 != 0 || operations.iter().any(|value| !value.is_finite())
        {
            return Err(Error::new(Status::InvalidArg, "canvas circle or operation buffer is malformed"));
        }
        if triangles.iter().any(|value| !value.is_finite()) {
            return Err(Error::new(Status::InvalidArg, "canvas triangle vertices must be finite"));
        }
        let (quads, images, order) = parse_ordered_display_list(display_list.as_ref(), (triangles.len() / 6) as u32, (circles.len() / 16) as u32, (beziers.len() / 13) as u32, &operations)?;
        self.present_parsed(quads, triangles, circles, beziers, images, order)
    }

    #[napi(js_name = "presentTransformed")]
    pub fn present_transformed(&mut self, display_list: Buffer) -> Result<PresentStats> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let (triangles, images, order) = parse_transformed_display_list(display_list.as_ref())?;
        self.present_parsed(Vec::new(), triangles, Vec::new(), Vec::new(), images, order)
    }
}

fn copy_f32_buffer(bytes: &[u8]) -> Vec<f32> {
    #[cfg(target_endian = "little")]
    if let Ok(values) = bytemuck::try_cast_slice::<u8, f32>(bytes) {
        return values.to_vec();
    }
    bytes.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

impl Window {
    fn present_display_list(
        &mut self,
        display_list: Buffer,
        images: Vec<ImageDraw>,
    ) -> Result<PresentStats> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let list = parse_display_list(display_list.as_ref())?;
        self.present_parsed(list, Vec::new(), Vec::new(), Vec::new(), images, Vec::new())
    }

    fn present_parsed(
        &mut self,
        list: Vec<f32>,
        triangles: Vec<f32>,
        circles: Vec<f32>,
        beziers: Vec<f32>,
        images: Vec<ImageDraw>,
        order: Vec<DrawOrder>,
    ) -> Result<PresentStats> {
        self.app.display_list = list;
        self.app.display_triangles = triangles;
        self.app.display_circles = circles;
        self.app.display_beziers = beziers;
        self.app.image_draws = images;
        self.app.draw_order = order;
        self.app.render_pending = true;
        let previous_count = self.app.last_render_count;
        if let Some(window) = self.app.window.as_ref() {
            window.request_redraw();
        }
        self.pump(Duration::ZERO)?;
        self.check_error()?;
        if self.app.last_render_count == previous_count {
            if let Some(window) = self.app.window.as_ref() {
                window.request_redraw();
            }
            self.pump(Duration::from_millis(2))?;
            self.check_error()?;
        }
        Ok(PresentStats {
            rendered: self.app.last_render_count > previous_count,
            native_render_ms: self.app.last_render_ms,
            prepare_ms: self.app.last_prepare_ms,
            acquire_ms: self.app.last_acquire_ms,
            submit_ms: self.app.last_submit_ms,
            present_ms: self.app.last_present_ms,
        })
    }
}

impl Window {
    fn pump(&mut self, timeout: Duration) -> Result<()> {
        match self
            .event_loop
            .pump_app_events(Some(timeout), &mut self.app)
        {
            PumpStatus::Continue => Ok(()),
            PumpStatus::Exit(_) => {
                self.app.closed = true;
                Ok(())
            }
        }
    }

    fn check_error(&mut self) -> Result<()> {
        if let Some(error) = self.app.error.take() {
            return Err(Error::new(Status::GenericFailure, error));
        }
        Ok(())
    }
}

fn parse_display_list(bytes: &[u8]) -> Result<Vec<f32>> {
    if bytes.len() < 4 || bytes.len() % 4 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "display list must be a Float32Array",
        ));
    }
    let values = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    if values[0] != 1.0 || (values.len() - 1) % 8 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "unsupported display list version or malformed quad data",
        ));
    }
    for quad in values[1..].chunks_exact(8) {
        if quad.iter().any(|value| !value.is_finite()) || quad[2] < 0.0 || quad[3] < 0.0 {
            return Err(Error::new(
                Status::InvalidArg,
                "quad values must be finite and have nonnegative dimensions",
            ));
        }
        if quad[4..].iter().any(|value| !(0.0..=1.0).contains(value)) {
            return Err(Error::new(
                Status::InvalidArg,
                "quad colors must be between zero and one",
            ));
        }
    }
    Ok(values[1..].to_vec())
}

fn parse_ordered_display_list(bytes: &[u8], canvas_vertex_count: u32, canvas_circle_count: u32, canvas_bezier_count: u32, canvas_operations: &[f32]) -> Result<(Vec<f32>, Vec<ImageDraw>, Vec<DrawOrder>)> {
    if bytes.len() < 8 || bytes.len() % 4 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "ordered display list must be a Float32Array",
        ));
    }
    let values = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    if values[0] != 2.0 || !values[1].is_finite() || values[1] < 0.0 || values[1].fract() != 0.0 {
        return Err(Error::new(
            Status::InvalidArg,
            "unsupported ordered display-list header",
        ));
    }
    let command_count = values[1] as usize;
    if command_count > 1_000_000 || values.len() != 2 + command_count * 10 {
        return Err(Error::new(
            Status::InvalidArg,
            "ordered display-list command count does not match its data",
        ));
    }

    let mut quads = Vec::new();
    let mut images = Vec::new();
    let mut order = Vec::<DrawOrder>::new();
    for record in values[2..].chunks_exact(10) {
        if record.iter().any(|value| !value.is_finite()) {
            return Err(Error::new(
                Status::InvalidArg,
                "display-list command values must be finite",
            ));
        }
        match record[0] {
            0.0 => {
                let quad = &record[1..9];
                if quad[2] < 0.0
                    || quad[3] < 0.0
                    || quad[4..].iter().any(|value| !(0.0..=1.0).contains(value))
                {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "solid command has invalid dimensions or color",
                    ));
                }
                let first_vertex = (quads.len() / 8 * 6) as u32;
                quads.extend_from_slice(quad);
                let last_vertex = first_vertex + 6;
                if let Some(DrawOrder::Solids(range)) = order.last_mut() {
                    range.end = last_vertex;
                } else {
                    order.push(DrawOrder::Solids(first_vertex..last_vertex));
                }
            }
            1.0 => {
                let texture_id = record[1];
                if texture_id < 1.0
                    || texture_id > u32::MAX as f32
                    || texture_id.fract() != 0.0
                    || record[4] < 0.0
                    || record[5] < 0.0
                    || record[6] < 0.0
                    || record[7] < 0.0
                    || record[8] < 0.0
                    || record[9] < 0.0
                {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "image command has an invalid texture or dimensions",
                    ));
                }
                let image_index = images.len();
                images.push(ImageDraw {
                    texture_id: texture_id as u32,
                    x: record[2] as f64,
                    y: record[3] as f64,
                    width: record[4] as f64,
                    height: record[5] as f64,
                    clip_x: Some(record[6] as f64),
                    clip_y: Some(record[7] as f64),
                    clip_width: Some(record[8] as f64),
                    clip_height: Some(record[9] as f64),
                    vertices: None,
                });
                order.push(DrawOrder::Image(image_index));
            }
            2.0 => {
                if record[3] < 0.0 || record[4] < 0.0 || record[5] < 0.0 {
                    return Err(Error::new(Status::InvalidArg, "backdrop blur has invalid bounds or radius"));
                }
                order.push(DrawOrder::BackdropBlur {
                    x: record[1], y: record[2], width: record[3], height: record[4], radius: record[5],
                });
            }
            3.0 => {
                let start = record[1];
                let count = record[2];
                if start < 0.0 || count < 0.0 || start.fract() != 0.0 || count.fract() != 0.0
                    || start + count > canvas_vertex_count as f32 || (count as u32) % 3 != 0
                    || record[5] < 0.0 || record[6] < 0.0
                {
                    return Err(Error::new(Status::InvalidArg, "canvas triangle command has invalid range or clip"));
                }
                let fallback = (start as u32)..((start + count) as u32);
                let commands = parse_canvas_operations(canvas_operations, canvas_vertex_count, canvas_circle_count, canvas_bezier_count, fallback)?;
                order.push(DrawOrder::CanvasProgram {
                    commands,
                    clip_x: record[3] as f64,
                    clip_y: record[4] as f64,
                    clip_width: record[5] as f64,
                    clip_height: record[6] as f64,
                });
            }
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "ordered display-list command type is unknown",
                ))
            }
        }
    }
    Ok((quads, images, order))
}

fn parse_canvas_operations(values: &[f32], triangle_vertex_count: u32, circle_count: u32, bezier_count: u32,
    fallback: std::ops::Range<u32>) -> Result<Vec<CanvasCommand>> {
    if values.is_empty() {
        return Ok(if fallback.is_empty() { Vec::new() } else { vec![CanvasCommand::Triangles(fallback)] });
    }
    if values.len() % 3 != 0 { return Err(Error::new(Status::InvalidArg, "canvas operation buffer must contain complete records")); }
    let mut commands = Vec::with_capacity(values.len() / 3);
    for record in values.chunks_exact(3) {
        let [kind, start, count] = [record[0], record[1], record[2]];
        if [kind, start, count].iter().any(|value| !value.is_finite() || value.fract() != 0.0)
            || start < 0.0 || count < 0.0
        { return Err(Error::new(Status::InvalidArg, "canvas operation has an invalid range")); }
        let start = start as u32; let count = count as u32;
        match kind as u32 {
            0 if start.checked_add(count).is_some_and(|end| end <= triangle_vertex_count) && count % 3 == 0 =>
                commands.push(CanvasCommand::Triangles(start..start + count)),
            1 if start.checked_add(count).is_some_and(|end| end <= circle_count) =>
                commands.push(CanvasCommand::Circles(start..start + count)),
            2 if start.checked_add(count).is_some_and(|end| end <= bezier_count) =>
                commands.push(CanvasCommand::Beziers(start..start + count)),
            _ => return Err(Error::new(Status::InvalidArg, "canvas operation references an invalid primitive range")),
        }
    }
    Ok(commands)
}

fn parse_transformed_display_list(
    bytes: &[u8],
) -> Result<(Vec<f32>, Vec<ImageDraw>, Vec<DrawOrder>)> {
    if bytes.len() < 8 || bytes.len() % 4 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "transformed display list must be a Float32Array",
        ));
    }
    let values = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    if !matches!(values[0], 3.0 | 4.0 | 5.0)
        || !values[1].is_finite()
        || values[1] < 0.0
        || values[1].fract() != 0.0
    {
        return Err(Error::new(
            Status::InvalidArg,
            "unsupported transformed display-list header",
        ));
    }
    if values[0] == 3.0 {
        let triangle_count = values[1] as usize;
        if triangle_count > 1_000_000 || values.len() != 2 + triangle_count * 11 {
            return Err(Error::new(
                Status::InvalidArg,
                "transformed display-list triangle count does not match its data",
            ));
        }
        let mut vertices = Vec::with_capacity(triangle_count * 18);
        for record in values[2..].chunks_exact(11) {
            if record.iter().any(|value| !value.is_finite())
                || record[0] != 0.0
                || record[7..11]
                    .iter()
                    .any(|value| !(0.0..=1.0).contains(value))
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "transformed triangle contains invalid coordinates or color",
                ));
            }
            for position in record[1..7].chunks_exact(2) {
                vertices.extend_from_slice(&[
                    position[0],
                    position[1],
                    record[7],
                    record[8],
                    record[9],
                    record[10],
                ]);
            }
        }
        let order = if triangle_count == 0 {
            Vec::new()
        } else {
            vec![DrawOrder::Triangles(0..(triangle_count * 3) as u32)]
        };
        return Ok((vertices, Vec::new(), order));
    }
    let triangle_count = values[1] as usize;
    if triangle_count > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "transformed display list contains too many commands",
        ));
    }
    let mut vertices = Vec::with_capacity(values.len().saturating_mul(2));
    let mut images = Vec::new();
    // Most adjacent triangle records collapse into a single GPU range.
    let mut order = Vec::with_capacity(triangle_count.min(64));
    let mut cursor = 2;
    for _ in 0..triangle_count {
        let tag = *values
            .get(cursor)
            .ok_or_else(|| Error::new(Status::InvalidArg, "truncated transformed display list"))?;
        cursor += 1;
        if tag == 0.0 {
            let end = cursor + 10;
            let record = values
                .get(cursor..end)
                .ok_or_else(|| Error::new(Status::InvalidArg, "truncated transformed triangle"))?;
            if record.iter().any(|value| !value.is_finite())
                || record[6..10]
                    .iter()
                    .any(|value| !(0.0..=1.0).contains(value))
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "transformed triangle contains invalid coordinates or color",
                ));
            }
            let start = (vertices.len() / 6) as u32;
            for position in record[0..6].chunks_exact(2) {
                vertices.extend_from_slice(&[
                    position[0],
                    position[1],
                    record[6],
                    record[7],
                    record[8],
                    record[9],
                ]);
            }
            let finish = (vertices.len() / 6) as u32;
            let extends_previous = matches!(order.last(), Some(DrawOrder::Triangles(previous)) if previous.end == start);
            if extends_previous {
                if let Some(DrawOrder::Triangles(previous)) = order.last_mut() {
                    previous.end = finish;
                }
            } else {
                order.push(DrawOrder::Triangles(start..finish));
            }
            cursor = end;
        } else if tag == 2.0 && values[0] == 5.0 {
            let header_end = cursor.checked_add(10).ok_or_else(|| {
                Error::new(Status::InvalidArg, "transformed canvas is too large")
            })?;
            let header = values.get(cursor..header_end).ok_or_else(|| {
                Error::new(Status::InvalidArg, "truncated transformed canvas header")
            })?;
            let (clip_x, clip_y, clip_width, clip_height) =
                (header[0], header[1], header[2], header[3]);
            let (origin_x, origin_y, scale_x, scale_y, opacity) =
                (header[4], header[5], header[6], header[7], header[8]);
            let canvas_triangles = header[9];
            if header.iter().any(|value| !value.is_finite())
                || clip_width < 0.0
                || clip_height < 0.0
                || !(0.0..=1.0).contains(&opacity)
                || canvas_triangles < 0.0
                || canvas_triangles.fract() != 0.0
                || canvas_triangles > 1_000_000.0
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "transformed canvas header is invalid",
                ));
            }
            let canvas_triangles = canvas_triangles as usize;
            cursor = header_end;
            let end = cursor
                .checked_add(canvas_triangles.checked_mul(10).ok_or_else(|| {
                    Error::new(Status::InvalidArg, "transformed canvas is too large")
                })?)
                .ok_or_else(|| Error::new(Status::InvalidArg, "transformed canvas is too large"))?;
            let raw_triangles = values.get(cursor..end).ok_or_else(|| {
                Error::new(Status::InvalidArg, "truncated transformed canvas triangles")
            })?;
            let start = (vertices.len() / 6) as u32;
            for triangle in raw_triangles.chunks_exact(10) {
                if triangle.iter().any(|value| !value.is_finite())
                    || triangle[6..10]
                        .iter()
                        .any(|value| !(0.0..=1.0).contains(value))
                {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "transformed canvas triangle is invalid",
                    ));
                }
                for position in triangle[0..6].chunks_exact(2) {
                    vertices.extend_from_slice(&[
                        origin_x + position[0] * scale_x,
                        origin_y + position[1] * scale_y,
                        triangle[6],
                        triangle[7],
                        triangle[8],
                        triangle[9] * opacity,
                    ]);
                }
            }
            let finish = (vertices.len() / 6) as u32;
            if finish > start {
                order.push(DrawOrder::CanvasTriangles {
                    range: start..finish,
                    clip_x: clip_x as f64,
                    clip_y: clip_y as f64,
                    clip_width: clip_width as f64,
                    clip_height: clip_height as f64,
                });
            }
            cursor = end;
        } else if tag == 1.0 {
            let header_end = cursor + 6;
            let header = values.get(cursor..header_end).ok_or_else(|| {
                Error::new(Status::InvalidArg, "truncated transformed image header")
            })?;
            let texture_id = header[0];
            let triangle_vertices = header[5];
            if !texture_id.is_finite()
                || texture_id <= 0.0
                || texture_id.fract() != 0.0
                || header[1..5].iter().any(|value| !value.is_finite())
                || header[3] < 0.0
                || header[4] < 0.0
                || !triangle_vertices.is_finite()
                || triangle_vertices < 3.0
                || triangle_vertices.fract() != 0.0
                || (triangle_vertices as usize) % 3 != 0
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "transformed image header is invalid",
                ));
            }
            cursor = header_end;
            let vertex_count = triangle_vertices as usize;
            let end = cursor
                .checked_add(vertex_count.checked_mul(5).ok_or_else(|| {
                    Error::new(Status::InvalidArg, "transformed image is too large")
                })?)
                .ok_or_else(|| Error::new(Status::InvalidArg, "transformed image is too large"))?;
            let raw_vertices = values.get(cursor..end).ok_or_else(|| {
                Error::new(Status::InvalidArg, "truncated transformed image vertices")
            })?;
            if raw_vertices
                .chunks_exact(5)
                .any(|vertex| vertex.iter().any(|value| !value.is_finite()) || vertex[4] <= 0.0)
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "transformed image vertex is invalid",
                ));
            }
            images.push(ImageDraw {
                texture_id: texture_id as u32,
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
                clip_x: Some(header[1] as f64),
                clip_y: Some(header[2] as f64),
                clip_width: Some(header[3] as f64),
                clip_height: Some(header[4] as f64),
                vertices: Some(raw_vertices.iter().map(|value| *value as f64).collect()),
            });
            order.push(DrawOrder::Image(images.len() - 1));
            cursor = end;
        } else {
            return Err(Error::new(
                Status::InvalidArg,
                "unknown transformed display-list command",
            ));
        }
    }
    if cursor != values.len() {
        return Err(Error::new(
            Status::InvalidArg,
            "transformed display list contains trailing data",
        ));
    }
    Ok((vertices, images, order))
}

impl LayoutTree {
    fn node(&self, handle: u32) -> Result<NodeId> {
        self.nodes
            .get(handle as usize)
            .copied()
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("invalid layout node: {handle}")))
    }
}
