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
            
