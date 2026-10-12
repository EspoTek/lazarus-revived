"""Generate the toolbar icons: a green rounded square with a white "revive" arrow."""
from PIL import Image, ImageDraw

OUT = "icons"
SIZES = [16, 32, 48, 128]
GREEN = (59, 122, 87, 255)
WHITE = (255, 255, 255, 255)


def draw_icon(size: int) -> Image.Image:
    scale = 8  # supersample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = s * 0.22
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=GREEN)

    # Circular arrow: an arc from ~40 deg to ~330 deg plus an arrowhead.
    pad = s * 0.22
    width = max(scale, int(s * 0.11))
    bbox = [pad, pad, s - pad, s - pad]
    d.arc(bbox, start=40, end=330, fill=WHITE, width=width)

    # Arrowhead at the arc's end (angle 330 deg), pointing clockwise.
    import math
    cx = cy = s / 2
    rad = (s - 2 * pad) / 2
    ang = math.radians(330)
    ex, ey = cx + rad * math.cos(ang), cy + rad * math.sin(ang)
    tangent = ang + math.pi / 2  # direction of travel along the arc
    head = s * 0.17
    tip = (ex + head * math.cos(tangent), ey + head * math.sin(tangent))
    left = (ex + head * 0.75 * math.cos(ang), ey + head * 0.75 * math.sin(ang))
    right = (ex - head * 0.75 * math.cos(ang), ey - head * 0.75 * math.sin(ang))
    d.polygon([tip, left, right], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    draw_icon(size).save(f"{OUT}/icon{size}.png")
    print("wrote", f"{OUT}/icon{size}.png")
