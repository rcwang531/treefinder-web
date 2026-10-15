"""Pixel-art favicon: left half a leafy crown, right half bare (dead) branches, one trunk.

Edit the TREE grid or colors, then regenerate the icons in web/public:
    python3 web/scripts/make_icon.py web/public
"""
import sys
from PIL import Image, ImageDraw

# 16x16 tree. G/L = crown (dark/light green), B = bare branch, T = trunk, . = empty
TREE = [
    "....GGGG........",
    "..GGLLGGB..B....",
    ".GLLGGGGB.B....B",
    ".GLGGGGGB.B.B.B.",
    "GGGGGGGGB.B.BB..",
    "GGGGGGLGBB..B...",
    "GGGGGLGGB..B....",
    "GGGGGGGGB.B...B.",
    ".GGGGGGGBB..BB..",
    "..GGGGGGBBBB....",
    "......TT........",
    "......TT........",
    "......TT........",
    "......TT........",
    "......TT........",
    ".....TTTT.......",
]
COLORS = {"G": "#2e7d32", "L": "#7cc456", "B": "#6e5544", "T": "#5d3a1e"}
BG, PAD, RADIUS = "#f3efe2", 2, 3  # light tile so the icon reads on dark tab bars
N = len(TREE) + 2 * PAD

def svg():
    rects = [f'<rect x="{x + PAD}" y="{y + PAD}" width="1" height="1" fill="{COLORS[c]}"/>'
             for y, row in enumerate(TREE) for x, c in enumerate(row) if c != "."]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}" shape-rendering="crispEdges">'
            f'<rect width="{N}" height="{N}" rx="{RADIUS}" fill="{BG}"/>' + "".join(rects) + "</svg>\n")

def png(size):
    scale = max(1, size // N)
    img = Image.new("RGBA", (N * scale, N * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, N * scale - 1, N * scale - 1], radius=RADIUS * scale, fill=BG)
    for y, row in enumerate(TREE):
        for x, c in enumerate(row):
            if c != ".":
                d.rectangle([(x + PAD) * scale, (y + PAD) * scale, (x + PAD + 1) * scale - 1, (y + PAD + 1) * scale - 1], fill=COLORS[c])
    return img.resize((size, size), Image.NEAREST)

out = sys.argv[1]
open(f"{out}/favicon.svg", "w").write(svg())
png(180).save(f"{out}/apple-touch-icon.png")
png(32).save(f"{out}/favicon-32.png")
