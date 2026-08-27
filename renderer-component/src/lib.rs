//! A GLB renderer Component for the Lagrange Object Environment (Phase 2 PR C).
//!
//! Modeled on the wasi-gfx skybox example's structure (persistent buffers, a
//! bind group, a Component-owned depth attachment, a per-frame uniform update),
//! but loading its geometry at RUNTIME from durable bytes via the
//! `lagrange:assets/provider` host import — upstream examples bake assets in at
//! build time with `include_bytes!`; this Component does not.
//!
//! Pressures (vs the PR B triangle): runtime asset transfer, vertex+index GPU
//! buffers, indexed draw (a new GpuIndexFormat seam through the shim), depth,
//! and a per-frame camera uniform (writeBufferWithCopy) driven by the frame
//! index (an auto-orbit; real pointer input is a separate follow-up slice).
//!
//! Supported GLB subset (the pinned rejection contract): exactly one primitive
//! with POSITION + NORMAL float32 non-interleaved accessors and a uint16 index
//! accessor; no materials, textures, Draco, or sparse accessors. Anything else
//! returns an error and the Component renders nothing.

mod glb;

use futures::StreamExt;
use wasi::webgpu::webgpu;
use wasi_gfx::surface::{surface, surface_webgpu};

wit_bindgen::generate!({
    path: "wit",
    world: "lagrange:glb-renderer/glb-renderer",
    generate_all,
});

export!(GlbRenderer);

use bytemuck::{Pod, Zeroable};
use std::cell::RefCell;

struct GlbRenderer;

impl Guest for GlbRenderer {
    async fn start() {
        match init().await {
            Ok(example) => {
                let example = RefCell::new(example);
                // Auto-orbit the camera from the frame index (exercises the
                // per-frame uniform writeBufferWithCopy path). Recreate the
                // depth texture on resize. Real pointer input is a follow-up.
                let frame_stream = example
                    .borrow()
                    .surface
                    .on_frame()
                    .into_stream()
                    .for_each(|_event| {
                        example.borrow_mut().render();
                        async {}
                    });
                let resize_stream = example
                    .borrow()
                    .surface
                    .on_resize()
                    .into_stream()
                    .for_each(|event| {
                        example.borrow_mut().on_resize(event.width, event.height);
                        async {}
                    });
                futures::join!(frame_stream, resize_stream);
            }
            Err(e) => {
                print(&format!("glb-renderer init failed: {e}"));
            }
        }
    }
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct Vertex {
    pos: [f32; 3],
    normal: [f32; 3],
}

pub struct Example {
    device: webgpu::GpuDevice,
    surface: surface::Surface,
    context: surface_webgpu::Context,
    frame_index: u32,
    screen_size: (u32, u32),
    pipeline: webgpu::GpuRenderPipeline,
    bind_group: webgpu::GpuBindGroup,
    uniform_buf: webgpu::GpuBuffer,
    vertex_buf: webgpu::GpuBuffer,
    index_buf: webgpu::GpuBuffer,
    index_count: u32,
    index_format: webgpu::GpuIndexFormat,
    depth_view: webgpu::GpuTextureView,
}

const SHADER: &str = r#"
struct Uniforms {
    mvp: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) normal: vec3f,
};

@vertex
fn vs(@location(0) pos: vec3f, @location(1) normal: vec3f) -> VsOut {
    var o: VsOut;
    o.pos = u.mvp * vec4f(pos, 1.0);
    o.normal = normal;
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    // Simple lambert-ish shading so the mesh reads as a shaded solid, not a
    // flat clear: light from above-front, base color distinct from the clear.
    let n = normalize(in.normal);
    let l = normalize(vec3f(0.3, 0.8, 0.5));
    let d = max(dot(n, l), 0.15);
    return vec4f(0.9 * d, 0.85 * d, 0.2 * d, 1.0);
}
"#;

impl Example {
    const DEPTH_FORMAT: webgpu::GpuTextureFormat = webgpu::GpuTextureFormat::Depth24plus;

    fn create_depth_view(
        device: &webgpu::GpuDevice,
        width: u32,
        height: u32,
    ) -> webgpu::GpuTextureView {
        let depth_texture = device.create_texture(&webgpu::GpuTextureDescriptor {
            size: webgpu::GpuExtent3D {
                width: width.max(1),
                height: Some(height.max(1)),
                depth_or_array_layers: Some(1),
            },
            mip_level_count: Some(1),
            sample_count: Some(1),
            dimension: Some(webgpu::GpuTextureDimension::D2),
            format: Example::DEPTH_FORMAT,
            usage: webgpu::GpuTextureUsage::RENDER_ATTACHMENT,
            label: None,
            view_formats: Some(vec![]),
            texture_binding_view_dimension: None,
        });
        depth_texture.create_view(None)
    }

    fn on_resize(&mut self, width: u32, height: u32) {
        self.screen_size = (width, height);
        self.depth_view = Self::create_depth_view(&self.device, width, height);
    }

    fn render(&mut self) {
        self.frame_index = self.frame_index.wrapping_add(1);
        // Keep the depth attachment matched to the surface size: the adapter
        // sizes the Surface AFTER construction (the Surface starts at the
        // Component's empty CreateDesc), so a 1x1-or-stale depth must be
        // recreated before it would be paired with a fresh-size color target.
        let (w, h) = (self.surface.width(), self.surface.height());
        if (w, h) != self.screen_size && w > 0 && h > 0 {
            self.screen_size = (w, h);
            self.depth_view = Self::create_depth_view(&self.device, w, h);
        }
        let texture = self.context.get_current_texture();
        let view = texture.create_view(None);
        let encoder = self
            .device
            .create_command_encoder(Some(&webgpu::GpuCommandEncoderDescriptor { label: None }));

        // Per-frame camera uniform (auto-orbit from the frame index).
        let mvp = self.camera_mvp();
        self.device
            .queue()
            .write_buffer_with_copy(&self.uniform_buf, 0, bytemuck::cast_slice(&mvp), None, None)
            .unwrap();

        {
            let rpass = encoder.begin_render_pass(&webgpu::GpuRenderPassDescriptor {
                label: None,
                color_attachments: vec![Some(webgpu::GpuRenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    load_op: webgpu::GpuLoadOp::Clear,
                    store_op: webgpu::GpuStoreOp::Store,
                    depth_slice: None,
                    // A dark clear color, distinct from the shaded mesh.
                    clear_value: Some(webgpu::GpuColor {
                        r: 0.05,
                        g: 0.05,
                        b: 0.08,
                        a: 1.0,
                    }),
                })],
                depth_stencil_attachment: Some(webgpu::GpuRenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_load_op: Some(webgpu::GpuLoadOp::Clear),
                    depth_store_op: Some(webgpu::GpuStoreOp::Store),
                    depth_clear_value: Some(1.0),
                    depth_read_only: Some(false),
                    stencil_load_op: None,
                    stencil_store_op: None,
                    stencil_clear_value: None,
                    stencil_read_only: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                max_draw_count: None,
            });

            rpass.set_pipeline(&self.pipeline);
            rpass
                .set_bind_group(0, Some(&self.bind_group), None, None, None)
                .unwrap();
            rpass.set_vertex_buffer(0, Some(&self.vertex_buf), None, None);
            rpass.set_index_buffer(&self.index_buf, self.index_format, None, None);
            rpass.draw_indexed(self.index_count, None, None, None, None);
            rpass.end();
        }

        self.device.queue().submit(&[&encoder.finish(None)]);
        self.context.present();
    }

    // A simple perspective * view (auto-orbit around the Y axis by frame index).
    fn camera_mvp(&self) -> [f32; 16] {
        let (w, h) = self.screen_size;
        let aspect = (w.max(1) as f32) / (h.max(1) as f32);
        let proj = glam::Mat4::perspective_rh(std::f32::consts::FRAC_PI_4, aspect, 0.1, 100.0);
        let angle = self.frame_index as f32 * 0.02;
        let cam_pos = glam::Vec3::new(angle.cos() * 4.0, 2.0, angle.sin() * 4.0);
        let view = glam::Mat4::look_at_rh(cam_pos, glam::Vec3::ZERO, glam::Vec3::Y);
        let mvp = proj * view;
        *AsRef::<[f32; 16]>::as_ref(&mvp)
    }
}

async fn init() -> Result<Example, String> {
    let gpu = webgpu::get_gpu();
    let device = gpu
        .request_adapter(None)
        .await
        .ok_or("request_adapter failed")?
        .request_device(None)
        .await
        .map_err(|e| format!("request_device: {e:?}"))?;

    let surface = surface::Surface::new(surface::CreateDesc {
        height: None,
        width: None,
    });
    let context = surface_webgpu::Context::new(&surface);
    context.configure(&surface_webgpu::ContextConfiguration {
        device: &device,
        format: gpu.get_preferred_canvas_format(),
        usage: None,
        view_formats: None,
        color_space: None,
        tone_mapping: None,
        alpha_mode: None,
    });

    let width = surface.width();
    let height = surface.height();

    // Load + parse the GLB at runtime (the asset-transfer seam).
    // Load the durable asset by its presentation-local name (the Component
    // never learns the underlying image/object identity — reference is not
    // authority). The host resolves + authorizes it per-attach.
    let bytes = crate::lagrange::assets::provider::load("main-model")
        .map_err(|e| format!("load: {e}"))?;
    let mesh = glb::parse_first_mesh(&bytes)?;

    // Build vertex buffer (interleaved pos+normal).
    let mut vertices: Vec<Vertex> = Vec::with_capacity(mesh.positions.len());
    for i in 0..mesh.positions.len() {
        vertices.push(Vertex {
            pos: mesh.positions[i],
            normal: mesh.normals.get(i).copied().unwrap_or([0.0, 1.0, 0.0]),
        });
    }
    let vertex_buf = create_buffer_init(&device, bytemuck::cast_slice(&vertices), webgpu::GpuBufferUsage::VERTEX);
    let index_buf = create_buffer_init(&device, bytemuck::cast_slice(&mesh.indices), webgpu::GpuBufferUsage::INDEX);

    // Uniform (mvp) buffer + bind group. COPY_DST so the per-frame
    // writeBufferWithCopy camera update can target it.
    let uniform_buf = create_buffer_init(
        &device,
        bytemuck::cast_slice(&[0f32; 16]),
        webgpu::GpuBufferUsage::UNIFORM | webgpu::GpuBufferUsage::COPY_DST,
    );
    let bind_group_layout = device.create_bind_group_layout(&webgpu::GpuBindGroupLayoutDescriptor {
        label: None,
        entries: vec![webgpu::GpuBindGroupLayoutEntry {
            binding: 0,
            visibility: webgpu::GpuShaderStage::VERTEX,
            buffer: Some(webgpu::GpuBufferBindingLayout {
                type_: Some(webgpu::GpuBufferBindingType::Uniform),
                has_dynamic_offset: Some(false),
                min_binding_size: None,
            }),
            sampler: None,
            texture: None,
            storage_texture: None,
        }],
    });
    let bind_group = device.create_bind_group(&webgpu::GpuBindGroupDescriptor {
        label: None,
        layout: &bind_group_layout,
        entries: vec![webgpu::GpuBindGroupEntry {
            binding: 0,
            resource: webgpu::GpuBindingResource::GpuBufferBinding(webgpu::GpuBufferBinding {
                buffer: &uniform_buf,
                offset: Some(0),
                size: Some(64),
            }),
        }],
    });

    let pipeline_layout = device.create_pipeline_layout(&webgpu::GpuPipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: vec![Some(&bind_group_layout)],
        immediate_size: None,
    });
    let shader = device.create_shader_module(&webgpu::GpuShaderModuleDescriptor {
        label: None,
        code: SHADER.to_string(),
        compilation_hints: None,
    });

    let pipeline = device.create_render_pipeline(webgpu::GpuRenderPipelineDescriptor {
        label: None,
        layout: webgpu::GpuLayoutMode::Specific(&pipeline_layout),
        vertex: webgpu::GpuVertexState {
            module: &shader,
            entry_point: Some("vs".to_string()),
            buffers: Some(vec![Some(webgpu::GpuVertexBufferLayout {
                array_stride: 24,
                step_mode: Some(webgpu::GpuVertexStepMode::Vertex),
                attributes: vec![
                    webgpu::GpuVertexAttribute {
                        format: webgpu::GpuVertexFormat::Float32x3,
                        offset: 0,
                        shader_location: 0,
                    },
                    webgpu::GpuVertexAttribute {
                        format: webgpu::GpuVertexFormat::Float32x3,
                        offset: 12,
                        shader_location: 1,
                    },
                ],
            })]),
            constants: None,
        },
        fragment: Some(webgpu::GpuFragmentState {
            module: &shader,
            entry_point: Some("fs".to_string()),
            targets: vec![Some(webgpu::GpuColorTargetState {
                format: gpu.get_preferred_canvas_format(),
                blend: None,
                write_mask: Some(webgpu::GpuColorWrite::ALL),
            })],
            constants: None,
        }),
        primitive: Some(webgpu::GpuPrimitiveState {
            topology: Some(webgpu::GpuPrimitiveTopology::TriangleList),
            strip_index_format: None,
            front_face: Some(webgpu::GpuFrontFace::Ccw),
            cull_mode: Some(webgpu::GpuCullMode::Back),
            unclipped_depth: None,
        }),
        depth_stencil: Some(webgpu::GpuDepthStencilState {
            format: Example::DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(webgpu::GpuCompareFunction::Less),
            stencil_front: None,
            stencil_back: None,
            stencil_read_mask: None,
            stencil_write_mask: None,
            depth_bias: None,
            depth_bias_slope_scale: None,
            depth_bias_clamp: None,
        }),
        multisample: Some(webgpu::GpuMultisampleState {
            count: Some(1),
            mask: Some(!0),
            alpha_to_coverage_enabled: Some(false),
        }),
    });

    let depth_view = Example::create_depth_view(&device, width, height);

    Ok(Example {
        device,
        surface,
        context,
        frame_index: 0,
        screen_size: (width, height),
        pipeline,
        bind_group,
        uniform_buf,
        vertex_buf,
        index_buf,
        index_count: mesh.indices.len() as u32,
        index_format: webgpu::GpuIndexFormat::Uint16,
        depth_view,
    })
}

// The device_create_buffer_init pattern: mappedAtCreation + set-with-copy +
// unmap. Returns the raw GpuBuffer (the shim exposes the underlying resource).
fn create_buffer_init(
    device: &webgpu::GpuDevice,
    contents: &[u8],
    usage: webgpu::GpuBufferUsage,
) -> webgpu::GpuBuffer {
    let buffer = device.create_buffer(&webgpu::GpuBufferDescriptor {
        label: None,
        size: contents.len() as u64,
        usage,
        mapped_at_creation: Some(true),
    });
    buffer
        .get_mapped_range_set_with_copy(contents, None, None)
        .unwrap();
    buffer.unmap().unwrap();
    buffer
}
