//! Image decoding shared by desktop nasty-native (worker pool) and the
//! NastyOS guest (event loop): same formats, same JPEG DCT downscale and
//! nearest resize to `max_edge`, so both produce identical textures.

/// Like `decode_image_rgba`, plus the source's intrinsic (pre-downscale) size,
/// which `HTMLImageElement.naturalWidth/naturalHeight` report.
pub fn decode_image_rgba_natural(
    encoded: &[u8],
    max_edge: u32,
) -> std::result::Result<(u32, u32, Vec<u8>, (u32, u32)), String> {
    let max_edge = max_edge.max(1);
    // Never call imageops::resize (rayon) from pool workers — nested deadlock.
    if let Ok(img) = try_decode_jpeg_scaled(encoded, max_edge) {
        return Ok(img);
    }
    let image = image::load_from_memory(encoded)
        .map_err(|error| format!("decode image: {error}"))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("decoded image has no dimensions".into());
    }
    let longest = width.max(height);
    if longest <= max_edge {
        return Ok((width, height, image.into_raw(), (width, height)));
    }
    let scale = f64::from(max_edge) / f64::from(longest);
    let next_width = ((f64::from(width) * scale).round() as u32).max(1);
    let next_height = ((f64::from(height) * scale).round() as u32).max(1);
    let resized = resize_rgba_nearest(&image, next_width, next_height);
    Ok((next_width, next_height, resized, (width, height)))
}

fn try_decode_jpeg_scaled(
    encoded: &[u8],
    max_edge: u32,
) -> std::result::Result<(u32, u32, Vec<u8>, (u32, u32)), String> {
    if encoded.len() < 3 || encoded[0] != 0xFF || encoded[1] != 0xD8 {
        return Err("not jpeg".into());
    }
    // Single decoder: read_info → scale(requested) → decode. jpeg-decoder picks
    // IDCT 1/1,1/2,1/4,1/8 from the requested size.
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(encoded));
    decoder.read_info().map_err(|e| format!("jpeg info: {e}"))?;
    let info = decoder
        .info()
        .ok_or_else(|| "jpeg missing info".to_string())?;
    let full_w = u32::from(info.width);
    let full_h = u32::from(info.height);
    if full_w == 0 || full_h == 0 {
        return Err("jpeg has no dimensions".into());
    }
    let longest = full_w.max(full_h);
    let (req_w, req_h) = if longest <= max_edge {
        (
            full_w.min(u32::from(u16::MAX)) as u16,
            full_h.min(u32::from(u16::MAX)) as u16,
        )
    } else {
        let s = f64::from(max_edge) / f64::from(longest);
        (
            ((f64::from(full_w) * s).round() as u32)
                .max(1)
                .min(u32::from(u16::MAX)) as u16,
            ((f64::from(full_h) * s).round() as u32)
                .max(1)
                .min(u32::from(u16::MAX)) as u16,
        )
    };
    decoder
        .scale(req_w, req_h)
        .map_err(|e| format!("jpeg scale: {e}"))?;
    let pixels = decoder.decode().map_err(|e| format!("jpeg decode: {e}"))?;
    let info = decoder
        .info()
        .ok_or_else(|| "jpeg missing info after decode".to_string())?;
    let width = u32::from(info.width);
    let height = u32::from(info.height);
    let rgba = jpeg_pixels_to_rgba(&pixels, info.pixel_format, width, height)?;
    let longest = width.max(height);
    if longest <= max_edge {
        return Ok((width, height, rgba, (full_w, full_h)));
    }
    let img = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "rgba buffer size mismatch".to_string())?;
    let s = f64::from(max_edge) / f64::from(longest);
    let nw = ((f64::from(width) * s).round() as u32).max(1);
    let nh = ((f64::from(height) * s).round() as u32).max(1);
    Ok((nw, nh, resize_rgba_nearest(&img, nw, nh), (full_w, full_h)))
}

fn jpeg_pixels_to_rgba(
    pixels: &[u8],
    format: jpeg_decoder::PixelFormat,
    width: u32,
    height: u32,
) -> std::result::Result<Vec<u8>, String> {
    let n = (width as usize).saturating_mul(height as usize);
    match format {
        jpeg_decoder::PixelFormat::L16 => {
            if pixels.len() < n * 2 {
                return Err("jpeg L16 underrun".into());
            }
            let mut out = vec![0u8; n * 4];
            for i in 0..n {
                // Take high byte.
                let g = pixels[i * 2];
                let o = i * 4;
                out[o] = g;
                out[o + 1] = g;
                out[o + 2] = g;
                out[o + 3] = 255;
            }
            Ok(out)
        }
        jpeg_decoder::PixelFormat::L8 => {
            if pixels.len() < n {
                return Err("jpeg L8 underrun".into());
            }
            let mut out = vec![0u8; n * 4];
            for i in 0..n {
                let g = pixels[i];
                let o = i * 4;
                out[o] = g;
                out[o + 1] = g;
                out[o + 2] = g;
                out[o + 3] = 255;
            }
            Ok(out)
        }
        jpeg_decoder::PixelFormat::RGB24 => {
            if pixels.len() < n * 3 {
                return Err("jpeg RGB underrun".into());
            }
            let mut out = vec![0u8; n * 4];
            for i in 0..n {
                let s = i * 3;
                let o = i * 4;
                out[o] = pixels[s];
                out[o + 1] = pixels[s + 1];
                out[o + 2] = pixels[s + 2];
                out[o + 3] = 255;
            }
            Ok(out)
        }
        jpeg_decoder::PixelFormat::CMYK32 => {
            if pixels.len() < n * 4 {
                return Err("jpeg CMYK underrun".into());
            }
            let mut out = vec![0u8; n * 4];
            for i in 0..n {
                let s = i * 4;
                let c = u16::from(pixels[s]);
                let m = u16::from(pixels[s + 1]);
                let y = u16::from(pixels[s + 2]);
                let k = u16::from(pixels[s + 3]);
                let o = i * 4;
                out[o] = (((255 - c) * (255 - k)) / 255) as u8;
                out[o + 1] = (((255 - m) * (255 - k)) / 255) as u8;
                out[o + 2] = (((255 - y) * (255 - k)) / 255) as u8;
                out[o + 3] = 255;
            }
            Ok(out)
        }
    }
}

fn resize_rgba_nearest(
    src: &image::RgbaImage,
    next_width: u32,
    next_height: u32,
) -> Vec<u8> {
    let (sw, sh) = src.dimensions();
    let mut out = vec![0u8; (next_width as usize) * (next_height as usize) * 4];
    if sw == 0 || sh == 0 || next_width == 0 || next_height == 0 {
        return out;
    }
    for y in 0..next_height {
        let sy = (u64::from(y) * u64::from(sh)) / u64::from(next_height);
        for x in 0..next_width {
            let sx = (u64::from(x) * u64::from(sw)) / u64::from(next_width);
            let p = src.get_pixel(sx as u32, sy as u32).0;
            let i = ((y as usize) * (next_width as usize) + (x as usize)) * 4;
            out[i..i + 4].copy_from_slice(&p);
        }
    }
    out
}
