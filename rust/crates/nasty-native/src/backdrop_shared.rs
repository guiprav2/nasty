//! CSS backdrop-filter blur on the GPU, shared by desktop nasty-native and
//! the NastyOS guest compositor: copy what is already drawn under the rect
//! (plus 3σ of context), downsample 4×, separable Gaussian, composite back
//! through rounded-rect masks.

use std::collections::HashMap;
use wgpu::util::DeviceExt;

pub struct BackdropResources {
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
    composite_params: wgpu::Buffer,
    downsample_pipeline: wgpu::RenderPipeline,
    blur_pipeline: wgpu::RenderPipeline,
    composite_pipeline: wgpu::RenderPipeline,
    small_width: u32,
    small_height: u32,
}

impl BackdropResources {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> Self {
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
        let composite_params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Nasty backdrop composite masks"), size: 64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
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
        let make_pipeline = |label: &'static str, fragment: String, bind_layout: &wgpu::BindGroupLayout, blend: Option<wgpu::BlendState>| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(fragment.into()) });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(label), bind_group_layouts: &[bind_layout], push_constant_ranges: &[] });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label), layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: Default::default(),
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })] }),
                multiview: None, cache: None,
            })
        };
        // One axis of a Gaussian with standard deviation params.z (in texels of the
        // downsampled copy), sampled densely out to 3σ. Each tap pair of adjacent
        // texels is read with one bilinear fetch at their weighted midpoint.
        let blur_shader = format!("{shader_source}
            @group(0) @binding(0) var tex: texture_2d<f32>; @group(0) @binding(1) var samp: sampler;
            @group(0) @binding(2) var<uniform> params: vec4<f32>;
            @fragment fn fs(i: Out) -> @location(0) vec4<f32> {{
                let texel = params.xy / vec2<f32>(textureDimensions(tex));
                let sigma = max(params.z, 0.5);
                let reach = min(i32(ceil(sigma * 3.0)), 192);
                let falloff = -0.5 / (sigma * sigma);
                var sum = textureSampleLevel(tex, samp, i.uv, 0.0);
                var total = 1.0;
                for (var k = 1; k <= reach; k = k + 2) {{
                    let a = f32(k);
                    let b = a + 1.0;
                    let wa = exp(a * a * falloff);
                    let wb = exp(b * b * falloff);
                    let w = wa + wb;
                    let offset = texel * ((a * wa + b * wb) / w);
                    sum += (textureSampleLevel(tex, samp, i.uv + offset, 0.0) + textureSampleLevel(tex, samp, i.uv - offset, 0.0)) * w;
                    total += 2.0 * w;
                }}
                return sum / total;
            }}");
        // 4×4 box average: four bilinear fetches, each the mean of a 2×2 block.
        let downsample_shader = format!("{shader_source}
            @group(0) @binding(0) var tex: texture_2d<f32>; @group(0) @binding(1) var samp: sampler;
            @fragment fn fs(i: Out) -> @location(0) vec4<f32> {{
                let t = 1.0 / vec2<f32>(textureDimensions(tex));
                return 0.25 * (textureSampleLevel(tex, samp, i.uv + t * vec2(-1.0, -1.0), 0.0)
                    + textureSampleLevel(tex, samp, i.uv + t * vec2(1.0, -1.0), 0.0)
                    + textureSampleLevel(tex, samp, i.uv + t * vec2(-1.0, 1.0), 0.0)
                    + textureSampleLevel(tex, samp, i.uv + t * vec2(1.0, 1.0), 0.0));
            }}");
        // The blurred backdrop, limited to the rounded-rect masks with antialiased
        // edges. Samples are premultiplied, so dividing by alpha leaves only real
        // content: transparent pixels beyond the window's own corners are not
        // averaged in as dark, see-through haze. The result is opaque where the
        // masks cover it and blends in by their coverage at the edges.
        let composite_shader = format!("{shader_source}
            @group(0) @binding(0) var tex: texture_2d<f32>; @group(0) @binding(1) var samp: sampler;
            struct Masks {{ a: vec4<f32>, a_radius: vec4<f32>, b: vec4<f32>, b_radius: vec4<f32> }};
            @group(0) @binding(2) var<uniform> masks: Masks;
            fn coverage(p: vec2<f32>, rect: vec4<f32>, radius: f32) -> f32 {{
                if (rect.z <= 0.0) {{ return 1.0; }}
                let half = rect.zw * 0.5;
                let r = min(radius, min(half.x, half.y));
                let q = abs(p - (rect.xy + half)) - (half - vec2(r));
                let d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
                return clamp(0.5 - d, 0.0, 1.0);
            }}
            @fragment fn fs(i: Out) -> @location(0) vec4<f32> {{
                let c = textureSample(tex, samp, i.uv);
                let cover = coverage(i.position.xy, masks.a, masks.a_radius.x) * coverage(i.position.xy, masks.b, masks.b_radius.x);
                return vec4(c.rgb / max(c.a, 0.0001), cover);
            }}");
        let composite_blend = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let downsample_pipeline = make_pipeline("Nasty backdrop downsample pipeline", downsample_shader, &simple_layout, None);
        let composite_pipeline = make_pipeline("Nasty backdrop composite pipeline", composite_shader, &layout, Some(composite_blend));
        let blur_pipeline = make_pipeline("Nasty backdrop blur pipeline", blur_shader, &layout, None);
        Self { source, small, horizontal, blurred,
            downsample_bind: make_simple_bind(&source_view),
            horizontal_bind: make_bind(&small_view, Some(&horizontal_params)),
            vertical_bind: make_bind(&horizontal_view, Some(&vertical_params)),
            composite_bind: make_bind(&blurred_view, Some(&composite_params)), horizontal_params, vertical_params, composite_params,
            downsample_pipeline, blur_pipeline, composite_pipeline, small_width, small_height }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn encode_backdrop_blur(
    cache: &mut HashMap<(u32, u32), BackdropResources>,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    format: wgpu::TextureFormat,
    surface_width: u32,
    surface_height: u32,
    encoder: &mut wgpu::CommandEncoder,
    surface: &wgpu::Texture,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
    masks: &[f32; 10],
) -> std::result::Result<(), String> {
        if width <= 0.0 || height <= 0.0 { return Ok(()); }
        let left = x.floor().clamp(0.0, surface_width as f32) as u32;
        let top = y.floor().clamp(0.0, surface_height as f32) as u32;
        let right = (x + width).ceil().clamp(0.0, surface_width as f32) as u32;
        let bottom = (y + height).ceil().clamp(0.0, surface_height as f32) as u32;
        if right <= left || bottom <= top { return Ok(()); }
        // The Gaussian reaches 3σ past the rect; copy that much context around it.
        let margin = (radius.max(0.0) * 3.0).ceil() as u32 + 4;
        let source_left = left.saturating_sub(margin);
        let source_top = top.saturating_sub(margin);
        let source_right = right.saturating_add(margin).min(surface_width);
        let source_bottom = bottom.saturating_add(margin).min(surface_height);
        let source_width = source_right - source_left;
        let source_height = source_bottom - source_top;
        let key = (source_width, source_height);
        if !cache.contains_key(&key) {
            cache.insert(key, BackdropResources::new(device, format, source_width, source_height));
        }
        let resources = cache.get(&key).expect("backdrop resources were just cached");
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: surface, mip_level: 0, origin: wgpu::Origin3d { x: source_left, y: source_top, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &resources.source, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: source_width, height: source_height, depth_or_array_layers: 1 },
        );
        // CSS blur(r) is a Gaussian with standard deviation r; the copy is at 1/4 scale.
        let sigma = (radius.max(0.0) / 4.0).max(0.5);
        queue.write_buffer(&resources.horizontal_params, 0, bytemuck::cast_slice(&[1.0_f32, 0.0, sigma, 0.0]));
        queue.write_buffer(&resources.vertical_params, 0, bytemuck::cast_slice(&[0.0_f32, 1.0, sigma, 0.0]));
        queue.write_buffer(&resources.composite_params, 0, bytemuck::cast_slice(&[
            masks[0], masks[1], masks[2], masks[3], masks[4], 0.0, 0.0, 0.0,
            masks[5], masks[6], masks[7], masks[8], masks[9], 0.0, 0.0, 0.0,
        ]));
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
        if right > left && bottom > top {
            let surface_view = surface.create_view(&wgpu::TextureViewDescriptor::default());
            let attachments = [Some(wgpu::RenderPassColorAttachment { view: &surface_view, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("Nasty backdrop composite"), color_attachments: &attachments,
                depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
            pass.set_viewport(source_left as f32, source_top as f32, source_width as f32, source_height as f32, 0.0, 1.0);
            pass.set_scissor_rect(left, top, right-left, bottom-top);
            pass.set_pipeline(&resources.composite_pipeline); pass.set_bind_group(0, &resources.composite_bind, &[]); pass.draw(0..3, 0..1);
        }
        Ok(())
}
