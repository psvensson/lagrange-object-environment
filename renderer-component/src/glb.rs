//! Minimal GLB (binary glTF) parsing for the pinned supported subset.
//!
//! A GLB is a 12-byte header, then a JSON chunk, then a BIN chunk. We parse the
//! JSON with serde_json, then slice accessor byte ranges out of the BIN chunk.
//! Supported subset (the rejection contract): exactly one primitive with
//! POSITION + NORMAL float32 non-interleaved accessors and a uint16 index
//! accessor; no materials, textures, Draco, or sparse accessors.

use serde_json::Value;

pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub indices: Vec<u16>,
}

const GLB_MAGIC: u32 = 0x4654_6C67; // "glTF"
const CHUNK_JSON: u32 = 0x4E4F_534A; // "JSON"
const CHUNK_BIN: u32 = 0x004E_4942; // "BIN\0"

const COMPONENT_FLOAT: u32 = 5126;
const COMPONENT_USHORT: u32 = 5123;

fn u32le(b: &[u8], off: usize) -> Result<u32, String> {
    b.get(off..off + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| "unexpected end of GLB".to_string())
}

pub fn parse_first_mesh(bytes: &[u8]) -> Result<Mesh, String> {
    // Header: magic, version, length.
    if u32le(bytes, 0)? != GLB_MAGIC {
        return Err("not a GLB (bad magic)".into());
    }
    // Chunk 0: JSON.
    let json_len = u32le(bytes, 12)? as usize;
    if u32le(bytes, 16)? != CHUNK_JSON {
        return Err("first GLB chunk is not JSON".into());
    }
    let json_start = 20;
    let json_end = json_start + json_len;
    let json: Value = serde_json::from_slice(
        bytes
            .get(json_start..json_end)
            .ok_or("truncated JSON chunk")?,
    )
    .map_err(|e| format!("GLB JSON parse: {e}"))?;

    // Chunk 1: BIN.
    let bin_len_off = json_end;
    let bin_len = u32le(bytes, bin_len_off)? as usize;
    if u32le(bytes, bin_len_off + 4)? != CHUNK_BIN {
        return Err("second GLB chunk is not BIN".into());
    }
    let bin_start = bin_len_off + 8;
    let bin = bytes
        .get(bin_start..bin_start + bin_len)
        .ok_or("truncated BIN chunk")?;

    let buffer_views = json
        .get("bufferViews")
        .and_then(Value::as_array)
        .ok_or("GLB has no bufferViews")?;
    let accessors = json
        .get("accessors")
        .and_then(Value::as_array)
        .ok_or("GLB has no accessors")?;

    // Exactly one mesh, one primitive.
    let meshes = json.get("meshes").and_then(Value::as_array).ok_or("no meshes")?;
    if meshes.len() != 1 {
        return Err(format!("expected exactly 1 mesh, got {}", meshes.len()));
    }
    let primitives = meshes[0]
        .get("primitives")
        .and_then(Value::as_array)
        .ok_or("no primitives")?;
    if primitives.len() != 1 {
        return Err(format!("expected exactly 1 primitive, got {}", primitives.len()));
    }
    let primitive = &primitives[0];
    if primitive.get("material").is_some() {
        return Err("materials are not supported in this subset".into());
    }
    let attributes = primitive
        .get("attributes")
        .ok_or("primitive has no attributes")?;

    let pos_accessor = accessor_index(attributes, "POSITION")?;
    let nrm_accessor = accessor_index(attributes, "NORMAL")?;
    let idx_accessor = primitive
        .get("indices")
        .and_then(Value::as_u64)
        .ok_or("primitive has no indices")? as usize;

    let positions = read_vec3_f32(accessors, buffer_views, bin, pos_accessor, "POSITION")?;
    let normals = read_vec3_f32(accessors, buffer_views, bin, nrm_accessor, "NORMAL")?;
    let indices = read_u16(accessors, buffer_views, bin, idx_accessor)?;

    Ok(Mesh {
        positions,
        normals,
        indices,
    })
}

fn accessor_index(attributes: &Value, name: &str) -> Result<usize, String> {
    attributes
        .get(name)
        .and_then(Value::as_u64)
        .map(|i| i as usize)
        .ok_or_else(|| format!("primitive missing {name} attribute"))
}

// The byte range of an accessor's data within the BIN chunk, rejecting
// interleaved data (byteStride) and sparse accessors, which this subset does
// not support.
fn accessor_slice<'a>(
    accessors: &[Value],
    buffer_views: &[Value],
    bin: &'a [u8],
    index: usize,
    expected_component: u32,
    expected_type: &str,
    component_count: usize,
) -> Result<&'a [u8], String> {
    let acc = accessors.get(index).ok_or("accessor index out of range")?;
    if acc.get("sparse").is_some() {
        return Err("sparse accessors are not supported".into());
    }
    let component_type = acc
        .get("componentType")
        .and_then(Value::as_u64)
        .ok_or("accessor missing componentType")? as u32;
    if component_type != expected_component {
        return Err(format!("unexpected componentType {component_type}"));
    }
    let type_ = acc.get("type").and_then(Value::as_str).ok_or("missing type")?;
    if type_ != expected_type {
        return Err(format!("unexpected accessor type {type_}"));
    }
    let count = acc.get("count").and_then(Value::as_u64).ok_or("missing count")? as usize;
    let bv_index = acc
        .get("bufferView")
        .and_then(Value::as_u64)
        .ok_or("accessor missing bufferView")? as usize;
    let bv = buffer_views.get(bv_index).ok_or("bufferView out of range")?;
    if bv.get("byteStride").is_some() {
        return Err("interleaved (byteStride) buffers are not supported".into());
    }
    let bv_offset = bv.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let acc_offset = acc.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let component_size = match expected_component {
        COMPONENT_FLOAT => 4,
        COMPONENT_USHORT => 2,
        _ => return Err("unsupported component size".into()),
    };
    let start = bv_offset + acc_offset;
    let len = count * component_count * component_size;
    bin.get(start..start + len)
        .ok_or_else(|| "accessor range out of BIN chunk".into())
}

fn read_vec3_f32(
    accessors: &[Value],
    buffer_views: &[Value],
    bin: &[u8],
    index: usize,
    name: &str,
) -> Result<Vec<[f32; 3]>, String> {
    let slice = accessor_slice(accessors, buffer_views, bin, index, COMPONENT_FLOAT, "VEC3", 3)?;
    if slice.len() % 12 != 0 {
        return Err(format!("{name} data is not a whole number of vec3f"));
    }
    let mut out = Vec::with_capacity(slice.len() / 12);
    for chunk in slice.chunks_exact(12) {
        out.push([
            f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
            f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
            f32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]),
        ]);
    }
    Ok(out)
}

fn read_u16(
    accessors: &[Value],
    buffer_views: &[Value],
    bin: &[u8],
    index: usize,
) -> Result<Vec<u16>, String> {
    let slice = accessor_slice(accessors, buffer_views, bin, index, COMPONENT_USHORT, "SCALAR", 1)?;
    if slice.len() % 2 != 0 {
        return Err("index data is not a whole number of u16".into());
    }
    Ok(slice
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect())
}
