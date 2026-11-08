"""Generate Apple macOS Sequoia-style squircle 16x16, 48x48, and 128x128 PNG icons for Antigravity Chrome Bridge."""
import os
import struct
import zlib
import math


def write_png(filepath: str, width: int, height: int, rgba_bytes: bytes) -> None:
    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba_bytes[y * stride : (y + 1) * stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(filepath, "wb") as f:
        f.write(png)


def seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    c1 = vx * wx + vy * wy
    if c1 <= 0:
        return math.hypot(px - ax, py - ay)
    c2 = vx * vx + vy * vy
    if c2 <= c1:
        return math.hypot(px - bx, py - by)
    ratio = c1 / c2
    return math.hypot(px - (ax + ratio * vx), py - (ay + ratio * vy))


def render_icon(size: int) -> bytes:
    buf = bytearray(size * size * 4)
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    half_scale = size / 2.0
    aa_px = 1.5 / size

    for y in range(size):
        for x in range(size):
            nx = (x - cx) / half_scale
            ny = (y - cy) / half_scale

            # Apple continuous superellipse squircle (n = 4.4)
            squircle_r = 0.88 if size >= 48 else 0.92
            sq_val = (abs(nx / squircle_r) ** 4.4 + abs(ny / squircle_r) ** 4.4) ** (1.0 / 4.4)
            edge_dist = (sq_val - 1.0) * squircle_r

            if edge_dist > aa_px:
                continue

            alpha = max(0.0, min(1.0, (aa_px - edge_dist) / (2.0 * aa_px)))

            # Apple System Blue vertical gradient (#2E9BFF -> #0071E3 -> #004EC4)
            vy = max(0.0, min(1.0, (ny + 0.9) / 1.8))
            if vy < 0.5:
                k = vy / 0.5
                r = 46 * (1.0 - k) + 0 * k
                g = 155 * (1.0 - k) + 119 * k
                b = 255 * (1.0 - k) + 237 * k
            else:
                k = (vy - 0.5) / 0.5
                r = 0 * (1.0 - k) + 0 * k
                g = 119 * (1.0 - k) + 78 * k
                b = 237 * (1.0 - k) + 196 * k

            # Subtle top-center ambient glow (macOS icon lighting)
            glow = max(0.0, 1.0 - math.hypot(nx * 0.9, ny + 0.58) / 0.95)
            r += 34 * (glow ** 2)
            g += 46 * (glow ** 2)
            b += 26 * (glow ** 2)

            # Top specular rim (1px glass highlight along upper squircle border)
            rim_band = abs(edge_dist + aa_px * 1.1)
            if rim_band < aa_px * 1.5 and ny < 0.2:
                rim_w = (1.0 - rim_band / (aa_px * 1.5)) * max(0.0, (-ny + 0.2) / 1.1) * 0.42
                r = r * (1.0 - rim_w) + 255 * rim_w
                g = g * (1.0 - rim_w) + 255 * rim_w
                b = b * (1.0 - rim_w) + 255 * rim_w

            # Precision orbital ring (Safari-inspired)
            if size >= 32:
                ring_d = abs(math.hypot(nx, ny) - 0.61)
                ring_stroke = max(0.026, 0.95 / size)
                if ring_d < ring_stroke + aa_px:
                    rw = max(0.0, min(1.0, (ring_stroke + aa_px - ring_d) / (1.8 * aa_px))) * 0.30
                    r = r * (1.0 - rw) + 255 * rw
                    g = g * (1.0 - rw) + 255 * rw
                    b = b * (1.0 - rw) + 255 * rw

            # Crisp geometric Bridge / "A" compass needle glyph
            stroke = max(0.105, 1.45 / size)
            d_left = seg_dist(nx, ny, 0.0, -0.42, -0.34, 0.38)
            d_right = seg_dist(nx, ny, 0.0, -0.42, 0.34, 0.38)
            d_arc = seg_dist(nx, ny, -0.20, 0.12, 0.20, 0.12)
            d_glyph = min(d_left, d_right, d_arc)

            # Soft drop shadow beneath white glyph
            d_shadow = min(
                seg_dist(nx, ny - 0.04, 0.0, -0.42, -0.34, 0.38),
                seg_dist(nx, ny - 0.04, 0.0, -0.42, 0.34, 0.38),
                seg_dist(nx, ny - 0.04, -0.20, 0.12, 0.20, 0.12),
            )
            if d_shadow < stroke + aa_px * 2.2:
                sw = max(0.0, min(1.0, (stroke + aa_px * 2.2 - d_shadow) / (aa_px * 2.5))) * 0.22
                r *= 1.0 - sw
                g *= 1.0 - sw
                b *= 1.0 - sw

            if d_glyph < stroke + aa_px:
                ga = max(0.0, min(1.0, (stroke + aa_px - d_glyph) / (1.8 * aa_px)))
                r = r * (1.0 - ga) + 255 * ga
                g = g * (1.0 - ga) + 255 * ga
                b = b * (1.0 - ga) + 255 * ga

            idx = (y * size + x) * 4
            buf[idx] = max(0, min(255, int(round(r))))
            buf[idx + 1] = max(0, min(255, int(round(g))))
            buf[idx + 2] = max(0, min(255, int(round(b))))
            buf[idx + 3] = max(0, min(255, int(round(alpha * 255))))

    return bytes(buf)


def main() -> None:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons_dir = os.path.join(base_dir, "extension", "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for sz in (16, 48, 128):
        out_path = os.path.join(icons_dir, f"icon-{sz}.png")
        write_png(out_path, sz, sz, render_icon(sz))
        print(f"Generated {out_path} ({sz}x{sz}px)")


if __name__ == "__main__":
    main()
