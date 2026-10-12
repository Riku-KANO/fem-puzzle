"""Minimal deterministic PNG writer/reader (RGBA8), independent of Blender's image I/O."""

from __future__ import annotations

import struct
import zlib


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_rgba(path: str, width: int, height: int, rgba: bytes) -> int:
    """`rgba`: width*height*4 bytes, rows top to bottom. Returns the file size."""
    assert len(rgba) == width * height * 4
    stride = width * 4
    raw = b"".join(b"\x00" + rgba[y * stride : (y + 1) * stride] for y in range(height))
    data = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


KEEP = {b"IHDR", b"PLTE", b"tRNS", b"sRGB", b"IDAT", b"IEND"}


def strip(path: str) -> int:
    """Drop ancillary chunks (Blender writes render date/time/stats as tEXt), so a re-render
    with identical pixels is byte-identical. Returns the new file size."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    out = [data[:8]]
    pos = 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        end = pos + 12 + length
        if tag in KEEP:
            out.append(data[pos:end])
        pos = end
    blob = b"".join(out)
    with open(path, "wb") as f:
        f.write(blob)
    return len(blob)


def size_of(path: str) -> tuple[int, int]:
    """(width, height) from the IHDR chunk of any PNG."""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        raise ValueError(f"{path}: not a PNG")
    return struct.unpack(">II", head[16:24])
