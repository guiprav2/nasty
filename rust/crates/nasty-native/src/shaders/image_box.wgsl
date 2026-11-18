                struct Viewport { size: vec2<f32> };
                @group(1) @binding(0) var<uniform> viewport: Viewport;
                @group(0) @binding(0) var image_texture: texture_2d<f32>;
                @group(0) @binding(1) var image_sampler: sampler;
                struct ImageBoxInput {
                    @location(0) rect: vec4<f32>, @location(1) uv: vec4<f32>, @location(2) radii: vec4<f32>,
                    @location(3) clip0: vec4<f32>, @location(4) clip1: vec4<f32>, @location(5) extra: vec4<f32>,
                };
                struct ImageBoxOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) point: vec2<f32>,
                    @location(1) uv: vec2<f32>,
                    @location(2) @interpolate(flat) rect: vec4<f32>, @location(3) @interpolate(flat) radii: vec4<f32>,
                    @location(4) @interpolate(flat) clip0: vec4<f32>, @location(5) @interpolate(flat) clip1: vec4<f32>,
                    @location(6) @interpolate(flat) extra: vec4<f32>,
                };
                fn sd_round_rect(p: vec2<f32>, rect: vec4<f32>, radii: vec4<f32>) -> f32 {
                    let half = rect.zw * 0.5;
                    let q = p - (rect.xy + half);
                    var r = select(radii.x, radii.y, q.x > 0.0);
                    if (q.y > 0.0) { r = select(radii.w, radii.z, q.x > 0.0); }
                    r = min(r, min(half.x, half.y));
                    let d = abs(q) - half + vec2<f32>(r);
                    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0) - r;
                }
                fn coverage(d: f32) -> f32 { return clamp(0.5 - d, 0.0, 1.0); }
                fn clip_coverage(p: vec2<f32>, clip: vec4<f32>, radius: f32) -> f32 {
                    if (clip.z <= 0.0 || clip.w <= 0.0) { return select(1.0, 0.0, clip.z < 0.0); }
                    return coverage(sd_round_rect(p, clip, vec4<f32>(radius)));
                }
                @vertex fn vs_main(input: ImageBoxInput, @builtin(vertex_index) vertex_index: u32) -> ImageBoxOutput {
                    let corners = array<vec2<f32>, 6>(
                        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
                    let corner = corners[vertex_index];
                    let point = input.rect.xy + corner * input.rect.zw;
                    var output: ImageBoxOutput;
                    output.position = vec4<f32>(point.x / viewport.size.x * 2.0 - 1.0, 1.0 - point.y / viewport.size.y * 2.0, 0.0, 1.0);
                    output.point = point;
                    output.uv = mix(input.uv.xy, input.uv.zw, corner);
                    output.rect = input.rect; output.radii = input.radii;
                    output.clip0 = input.clip0; output.clip1 = input.clip1; output.extra = input.extra;
                    return output;
                }
                @fragment fn fs_main(input: ImageBoxOutput) -> @location(0) vec4<f32> {
                    let color = textureSample(image_texture, image_sampler, input.uv);
                    var cover = input.extra.z;
                    if (any(input.radii > vec4<f32>(0.0))) { cover = cover * coverage(sd_round_rect(input.point, input.rect, input.radii)); }
                    cover = cover * clip_coverage(input.point, input.clip0, input.extra.x)
                        * clip_coverage(input.point, input.clip1, input.extra.y);
                    if (cover <= 0.0) { discard; }
                    return vec4<f32>(color.rgb, color.a * cover);
                }
            
