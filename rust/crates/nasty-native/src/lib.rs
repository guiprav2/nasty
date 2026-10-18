//! Small Node binding for Taffy. The document and frame clock live in JavaScript.

use glyphon::{
    Attrs, Buffer as TextBuffer, Cache as TextCache, Color as TextColor, Family, FontSystem,
    Metrics, Resolution, Shaping, SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer,
    Viewport,
};
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::sync::Arc;
use std::time::{Duration, Instant};
use taffy::prelude::*;
use taffy::tree::TaffyError;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent as OsWindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
use winit::window::{Window as OsWindow, WindowId};

#[napi(object)]
#[derive(Default)]
pub struct LayoutStyle {
    pub display: Option<String>,
    pub direction: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub width_percent: Option<f64>,
    pub height_percent: Option<f64>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub padding: Option<f64>,
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

fn convert_style(input: LayoutStyle) -> Result<Style> {
    let mut style = Style::default();
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
    if let Some(value) = input.padding {
        let value = LengthPercentage::length(finite_nonnegative(value, "padding")?);
        style.padding = Rect {
            left: value,
            right: value,
            top: value,
            bottom: value,
        };
    }
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
            "start" => AlignItems::START,
            "end" => AlignItems::END,
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
            "start" => JustifyContent::START,
            "end" => JustifyContent::END,
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
    tree: TaffyTree<()>,
    nodes: Vec<NodeId>,
}

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
            .new_leaf(convert_style(style)?)
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
    pub fn compute(&mut self, root: u32, width: f64, height: f64) -> Result<()> {
        let root = self.node(root)?;
        let width = finite_nonnegative(width, "viewport width")?;
        let height = finite_nonnegative(height, "viewport height")?;
        self.tree
            .compute_layout(
                root,
                Size {
                    width: AvailableSpace::Definite(width),
                    height: AvailableSpace::Definite(height),
                },
            )
            .map_err(taffy_error)
    }

    #[napi]
    pub fn layout(&self, handle: u32) -> Result<LayoutBox> {
        let layout = self.tree.layout(self.node(handle)?).map_err(taffy_error)?;
        Ok(LayoutBox {
            x: layout.location.x as f64,
            y: layout.location.y as f64,
            width: layout.size.width as f64,
            height: layout.size.height as f64,
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

// Display list v1 is a Float32Array: [1, x, y, width, height, r, g, b, a, ...].
// Coordinates are physical window pixels and colors are straight RGBA in [0, 1].
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    position: [f32; 2],
    color: [f32; 4],
}

#[napi(object)]
pub struct WindowOptions {
    pub title: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[napi(object)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct NativeEvent {
    #[napi(js_name = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub key: Option<String>,
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

#[napi(object)]
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
}

#[napi(object)]
pub struct TextPreparationStats {
    #[napi(js_name = "systemFontInitMs")]
    pub system_font_init_ms: f64,
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
    pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
    vertex_capacity: usize,
    font_system: Option<FontSystem>,
    system_font_init_ms: f64,
    swash_cache: SwashCache,
    text_viewport: Viewport,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    text_buffers: Vec<PositionedText>,
    adapter_name: String,
    format_name: String,
    present_mode_name: String,
}

struct PositionedText {
    buffer: TextBuffer,
    x: f32,
    y: f32,
    color: TextColor,
}

impl Renderer {
    fn new(window: Arc<OsWindow>) -> std::result::Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
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
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|error| format!("create GPU device: {error}"))?;

        let capabilities = surface.get_capabilities(&adapter);
        let format = capabilities
            .formats
            .iter()
            .copied()
            .find(wgpu::TextureFormat::is_srgb)
            .or_else(|| capabilities.formats.first().copied())
            .ok_or_else(|| "GPU surface has no supported formats".to_string())?;
        let format_name = format!("{format:?}");
        let present_mode = if capabilities
            .present_modes
            .contains(&wgpu::PresentMode::Mailbox)
        {
            wgpu::PresentMode::Mailbox
        } else if capabilities
            .present_modes
            .contains(&wgpu::PresentMode::Fifo)
        {
            wgpu::PresentMode::Fifo
        } else {
            *capabilities
                .present_modes
                .first()
                .ok_or_else(|| "GPU surface has no presentation modes".to_string())?
        };
        let present_mode_name = format!("{present_mode:?}");
        let alpha_mode = *capabilities
            .alpha_modes
            .first()
            .ok_or_else(|| "GPU surface has no alpha modes".to_string())?;
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
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
                buffers: &[vertex_layout],
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
        // Avoid a visible first-frame allocation for ordinary display lists.
        // Larger lists still grow geometrically in `render`.
        let vertex_capacity = 64 * 6 * std::mem::size_of::<Vertex>();
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty display list vertices"),
            size: vertex_capacity as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        // Create the first staging upload before the animation loop without
        // waiting for the GPU; the first real frame flushes this queued upload.
        let warmup_data = vec![0_u8; vertex_capacity];
        queue.write_buffer(&vertex_buffer, 0, &warmup_data);

        // Defer font discovery until text is requested so ordinary windows do
        // not pay system-font startup cost.
        let font_system = None;
        let swash_cache = SwashCache::new();
        let text_cache = TextCache::new(&device);
        let mut text_viewport = Viewport::new(&device, &text_cache);
        text_viewport.update(
            &queue,
            Resolution {
                width: config.width,
                height: config.height,
            },
        );
        let mut text_atlas = TextAtlas::new(&device, &queue, &text_cache, format);
        let text_renderer = TextRenderer::new(
            &mut text_atlas,
            &device,
            wgpu::MultisampleState::default(),
            None,
        );

        Ok(Self {
            surface,
            device,
            queue,
            config,
            pipeline,
            vertex_buffer,
            vertex_capacity,
            font_system,
            system_font_init_ms: 0.0,
            swash_cache,
            text_viewport,
            text_atlas,
            text_renderer,
            text_buffers: Vec::new(),
            adapter_name,
            format_name,
            present_mode_name,
        })
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.text_viewport
            .update(&self.queue, Resolution { width, height });
    }

    fn render(
        &mut self,
        window: &OsWindow,
        list: &[f32],
    ) -> std::result::Result<RenderTimings, String> {
        let started = Instant::now();
        let prepare_started = Instant::now();
        let mut vertices = Vec::with_capacity((list.len() / 8) * 6);
        let width = self.config.width as f32;
        let height = self.config.height as f32;
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
        {
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 0.035,
                        g: 0.047,
                        b: 0.078,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Nasty display list pass"),
                color_attachments: &attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if !vertices.is_empty() {
                pass.set_pipeline(&self.pipeline);
                pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                pass.draw(0..vertices.len() as u32, 0..1);
            }
            if !self.text_buffers.is_empty() {
                self.text_renderer
                    .render(&self.text_atlas, &self.text_viewport, &mut pass)
                    .map_err(|error| format!("render text: {error}"))?;
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

    fn set_text_runs(
        &mut self,
        runs: Vec<TextRunOptions>,
    ) -> std::result::Result<TextPreparationStats, String> {
        let total_started = Instant::now();
        if self.font_system.is_none() {
            let font_init_started = Instant::now();
            self.font_system = Some(FontSystem::new());
            self.system_font_init_ms = font_init_started.elapsed().as_secs_f64() * 1000.0;
        }
        let font_system = self.font_system.as_mut().expect("font system initialized");
        let shaping_started = Instant::now();
        let mut glyph_count = 0_u32;
        let mut line_count = 0_u32;
        let height = self.config.height as f32;
        let mut positioned = Vec::with_capacity(runs.len());

        for run in runs {
            let [x, y, run_width, font_size, line_height] =
                [run.x, run.y, run.width, run.font_size, run.line_height];
            if [x, y, run_width, font_size, line_height]
                .iter()
                .any(|value| !value.is_finite())
                || x < 0.0
                || y < 0.0
                || run_width < 0.0
                || font_size <= 0.0
                || line_height <= 0.0
                || run_width > f32::MAX as f64
                || font_size > f32::MAX as f64
                || line_height > f32::MAX as f64
            {
                return Err("text run geometry and font metrics must be finite and nonnegative (font size and line height must be positive)".into());
            }
            let color = parse_text_color(&run.color)
                .ok_or_else(|| format!("invalid text color: {}", run.color))?;
            let mut buffer = TextBuffer::new(
                font_system,
                Metrics::new(font_size as f32, line_height as f32),
            );
            buffer.set_size(
                font_system,
                Some((run_width as f32).max(1.0)),
                Some((height - y as f32).max(1.0)),
            );
            buffer.set_text(
                font_system,
                &run.text,
                Attrs::new().family(Family::SansSerif),
                Shaping::Advanced,
            );
            buffer.shape_until_scroll(font_system, false);
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

        self.text_viewport.update(
            &self.queue,
            Resolution {
                width: self.config.width,
                height: self.config.height,
            },
        );
        let bounds = TextBounds {
            left: 0,
            top: 0,
            right: self.config.width.min(i32::MAX as u32) as i32,
            bottom: self.config.height.min(i32::MAX as u32) as i32,
        };
        let text_areas = positioned
            .iter()
            .map(|text| TextArea {
                buffer: &text.buffer,
                left: text.x,
                top: text.y,
                scale: 1.0,
                bounds,
                default_color: text.color,
                custom_glyphs: &[],
            })
            .collect::<Vec<_>>();
        let prepare_started = Instant::now();
        self.text_renderer
            .prepare(
                &self.device,
                &self.queue,
                font_system,
                &mut self.text_atlas,
                &self.text_viewport,
                text_areas,
                &mut self.swash_cache,
            )
            .map_err(|error| error.to_string())?;
        let atlas_prepare_ms = prepare_started.elapsed().as_secs_f64() * 1000.0;
        self.text_buffers = positioned;

        Ok(TextPreparationStats {
            system_font_init_ms: self.system_font_init_ms,
            glyph_count,
            line_count,
            shaping_ms,
            atlas_prepare_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    fn system_font_init_ms(&self) -> f64 {
        self.system_font_init_ms
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
    window: Option<Arc<OsWindow>>,
    renderer: Option<Renderer>,
    error: Option<String>,
    events: Vec<NativeEvent>,
    cursor: (f64, f64),
    display_list: Vec<f32>,
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
            .with_inner_size(LogicalSize::new(self.width, self.height));
        match event_loop.create_window(attributes) {
            Ok(window) => {
                let window = Arc::new(window);
                match Renderer::new(window.clone()) {
                    Ok(renderer) => {
                        self.window = Some(window);
                        self.renderer = Some(renderer);
                    }
                    Err(error) => self.error = Some(error),
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
        match event {
            OsWindowEvent::CloseRequested => {
                self.closed = true;
                self.window = None;
                self.renderer = None;
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
                    });
                }
            }
            OsWindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
                self.events.push(NativeEvent {
                    kind: "pointermove".into(),
                    x: position.x,
                    y: position.y,
                    key: None,
                });
            }
            OsWindowEvent::MouseInput { state, .. } => self.events.push(NativeEvent {
                kind: if state.is_pressed() {
                    "pointerdown"
                } else {
                    "pointerup"
                }
                .into(),
                x: self.cursor.0,
                y: self.cursor.1,
                key: None,
            }),
            OsWindowEvent::KeyboardInput { event, .. } => self.events.push(NativeEvent {
                kind: if event.state.is_pressed() {
                    "keydown"
                } else {
                    "keyup"
                }
                .into(),
                x: self.cursor.0,
                y: self.cursor.1,
                key: Some(format!("{:?}", event.logical_key)),
            }),
            OsWindowEvent::RedrawRequested if self.render_pending => {
                self.render_pending = false;
                let Some(window) = self.window.as_ref() else {
                    return;
                };
                let Some(renderer) = self.renderer.as_mut() else {
                    return;
                };
                match renderer.render(window, &self.display_list) {
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

#[napi]
pub struct Window {
    event_loop: EventLoop<()>,
    app: WindowApp,
}

#[napi]
impl Window {
    #[napi(constructor)]
    pub fn new(options: WindowOptions) -> Result<Self> {
        let event_loop = EventLoop::new().map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("create event loop: {error}"),
            )
        })?;
        let app = WindowApp {
            title: options.title.unwrap_or_else(|| "Nasty".into()),
            width: options.width.unwrap_or(960.0),
            height: options.height.unwrap_or(600.0),
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
        window.pump(Duration::ZERO)?;
        window.check_error()?;
        Ok(window)
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

    #[napi(js_name = "setTextRuns")]
    pub fn set_text_runs(&mut self, runs: Vec<TextRunOptions>) -> Result<TextPreparationStats> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let renderer = self
            .app
            .renderer
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "GPU renderer is unavailable"))?;
        renderer
            .set_text_runs(runs)
            .map_err(|error| Error::new(Status::InvalidArg, error))
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

    #[napi]
    pub fn is_closed(&self) -> bool {
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

    #[napi]
    pub fn present(&mut self, display_list: Buffer) -> Result<PresentStats> {
        if self.app.closed {
            return Err(Error::new(Status::GenericFailure, "window is closed"));
        }
        let list = parse_display_list(display_list.as_ref())?;
        self.app.display_list = list;
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

impl LayoutTree {
    fn node(&self, handle: u32) -> Result<NodeId> {
        self.nodes
            .get(handle as usize)
            .copied()
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("invalid layout node: {handle}")))
    }
}
