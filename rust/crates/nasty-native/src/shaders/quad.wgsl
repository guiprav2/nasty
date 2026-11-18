                struct VertexInput {
                    @location(0) position: vec2<f32>,
                    @location(1) color: vec4<f32>,
                };
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) color: vec4<f32>,
                };
                fn srgb_to_linear(value: vec3<f32>) -> vec3<f32> {
                    let low = value / vec3<f32>(12.92);
                    let high = pow((value + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
                    return select(high, low, value <= vec3<f32>(0.04045));
                }
                @vertex fn vs_main(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = vec4<f32>(input.position, 0.0, 1.0);
                    output.color = input.color;
                    return output;
                }
                @fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                    return vec4<f32>(__OUTPUT_RGB__, input.color.a);
                }
                
