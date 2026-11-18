                struct Viewport { size: vec2<f32> };
                @group(0) @binding(0) var<uniform> viewport: Viewport;
                struct BoxInput {
                    @location(0) rect: vec4<f32>, @location(1) radii: vec4<f32>,
                    @location(2) c0: vec4<f32>, @location(3) c1: vec4<f32>,
                    @location(4) c2: vec4<f32>, @location(5) c3: vec4<f32>,
                    @location(6) stops: vec4<f32>, @location(7) line: vec4<f32>,
                    @location(8) border: vec4<f32>, @location(9) border_color: vec4<f32>,
                    @location(10) clip0: vec4<f32>, @location(11) clip1: vec4<f32>,
                    @location(12) extra: vec4<f32>,
                };
                struct BoxOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) point: vec2<f32>,
                    @location(1) @interpolate(flat) rect: vec4<f32>, @location(2) @interpolate(flat) radii: vec4<f32>,
                    @location(3) @interpolate(flat) c0: vec4<f32>, @location(4) @interpolate(flat) c1: vec4<f32>,
                    @location(5) @interpolate(flat) c2: vec4<f32>, @location(6) @interpolate(flat) c3: vec4<f32>,
                    @location(7) @interpolate(flat) stops: vec4<f32>, @location(8) @interpolate(flat) line: vec4<f32>,
                    @location(9) @interpolate(flat) border: vec4<f32>, @location(10) @interpolate(flat) border_color: vec4<f32>,
                    @location(11) @interpolate(flat) clip0: vec4<f32>, @location(12) @interpolate(flat) clip1: vec4<f32>,
                    @location(13) @interpolate(flat) extra: vec4<f32>,
                };
                fn srgb_to_linear(value: vec3<f32>) -> vec3<f32> {
                    let low = value / vec3<f32>(12.92);
                    let high = pow((value + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
                    return select(high, low, value <= vec3<f32>(0.04045));
                }
                // Signed distance to a rounded rect with per-corner radii (y down).
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
                @vertex fn vs_main(input: BoxInput, @builtin(vertex_index) vertex_index: u32) -> BoxOutput {
                    let corners = array<vec2<f32>, 6>(
                        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
                    // One pixel of slack on every side for antialiased edges.
                    let point = input.rect.xy - vec2<f32>(1.0) + corners[vertex_index] * (input.rect.zw + vec2<f32>(2.0));
                    var output: BoxOutput;
                    output.position = vec4<f32>(point.x / viewport.size.x * 2.0 - 1.0, 1.0 - point.y / viewport.size.y * 2.0, 0.0, 1.0);
                    output.point = point;
                    output.rect = input.rect; output.radii = input.radii;
                    output.c0 = input.c0; output.c1 = input.c1; output.c2 = input.c2; output.c3 = input.c3;
                    output.stops = input.stops; output.line = input.line;
                    output.border = input.border; output.border_color = input.border_color;
                    output.clip0 = input.clip0; output.clip1 = input.clip1; output.extra = input.extra;
                    return output;
                }
                fn premultiplied(color: vec4<f32>) -> vec4<f32> { return vec4<f32>(color.rgb * color.a, color.a); }
                fn segment(a: vec4<f32>, b: vec4<f32>, lo: f32, hi: f32, t: f32) -> vec4<f32> {
                    return mix(premultiplied(a), premultiplied(b), clamp((t - lo) / max(hi - lo, 1e-6), 0.0, 1.0));
                }
                fn fill_color(input: BoxOutput) -> vec4<f32> {
                    let count = input.extra.z;
                    if (count < 1.5) { return premultiplied(input.c0); }
                    let direction = input.line.zw - input.line.xy;
                    let t = clamp(dot(input.point - input.line.xy, direction) / max(dot(direction, direction), 1e-6), 0.0, 1.0);
                    let s = input.stops;
                    if (t <= s.x) { return premultiplied(input.c0); }
                    if (t <= s.y || count < 2.5) { return segment(input.c0, input.c1, s.x, s.y, t); }
                    if (t <= s.z || count < 3.5) { return segment(input.c1, input.c2, s.y, s.z, t); }
                    return segment(input.c2, input.c3, s.z, s.w, t);
                }
                @fragment fn fs_main(input: BoxOutput) -> @location(0) vec4<f32> {
                    let outer = coverage(sd_round_rect(input.point, input.rect, input.radii));
                    var inner = outer;
                    let border = input.border;
                    if (any(border > vec4<f32>(0.0))) {
                        let inner_rect = vec4<f32>(input.rect.x + border.w, input.rect.y + border.x,
                            input.rect.z - border.y - border.w, input.rect.w - border.x - border.z);
                        let inner_radii = max(input.radii - vec4<f32>(max(border.x, border.w), max(border.x, border.y),
                            max(border.z, border.y), max(border.z, border.w)), vec4<f32>(0.0));
                        inner = select(0.0, min(outer, coverage(sd_round_rect(input.point, inner_rect, inner_radii))),
                            inner_rect.z > 0.0 && inner_rect.w > 0.0);
                    }
                    var color = fill_color(input) * inner + premultiplied(input.border_color) * (outer - inner);
                    color = color * clip_coverage(input.point, input.clip0, input.extra.x)
                        * clip_coverage(input.point, input.clip1, input.extra.y);
                    if (color.a <= 0.0) { discard; }
                    let rgb = color.rgb / color.a;
                    return vec4<f32>(__OUTPUT_RGB__, color.a);
                }
            
