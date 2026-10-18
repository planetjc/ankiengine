#!/usr/bin/env python3
"""Render the AnkiEngine mark and app icon with nothing but the standard library.

The mark is a flywheel made of cards: six cards round a hub, each lying on
the one before, so every joint shows a card edge, and each card written on
(two lines from the top left) so it reads as a card rather than a chain link.

No rasteriser is installed on this machine -- no ImageMagick, no rsvg, no
Pillow, and QuickLook has no SVG generator -- so this does the job itself:
shapes are flattened to polygons, filled by scanline with the nonzero rule,
4x vertical subsampling and fractional horizontal coverage (that is the
antialiasing), and written as a PNG through zlib.

One geometry feeds everything. The mark is a single path filled nonzero:
cards run clockwise, and what is cut out of them -- the edge of the next card,
the writing -- runs anticlockwise, so it subtracts. That path is what
shell.css masks into the rail and what the site draws; this script prints it.

    python3 scripts/render-icon.py app-icon.png   # writes the PNG, prints the paths
    npx tauri icon app-icon.png

Two sizes of the mark: the full one, written on, for the icon and anywhere
the mark is 24px or more; and a small one for the 10-17px marks (the steps,
the composer, the deck track), where the writing would only be noise, so it
goes, and the cut between cards widens so the joints still show.
"""
import math
import struct
import sys
import zlib

# ---- the mark, in a 24-unit box ------------------------------------------------
N = 6                 # cards round the hub
R = 7.9               # centre of each card from the centre of the hub
L, T = 8.4, 5.1       # a card, before its edge is cut
RR = 1.0              # its corner
HUB, HOLE = 3.4, 1.3


def rot(p, a, c=(12.0, 12.0)):
    """Turn p by a degrees clockwise (y down, as SVG's rotate) about c."""
    t = math.radians(a)
    x, y = p[0] - c[0], p[1] - c[1]
    return (c[0] + x * math.cos(t) - y * math.sin(t), c[1] + x * math.sin(t) + y * math.cos(t))


def rrect(x, y, w, h, r, seg=16):
    """A rounded rectangle as points, clockwise on screen."""
    r = max(min(r, w / 2, h / 2), 0.0)
    pts = []
    for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def circle(cx, cy, r, seg=96):
    return [(cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]


def signed_area(pts):
    return 0.5 * sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))


def clip(subject, clipper):
    """Sutherland-Hodgman: subject inside a convex clipper."""
    sign = 1.0 if signed_area(clipper) > 0 else -1.0

    def inside(p, a, b):
        return sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0

    def meet(p, q, a, b):
        x1, y1, x2, y2, x3, y3, x4, y4 = p[0], p[1], q[0], q[1], a[0], a[1], b[0], b[1]
        d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))

    out = subject
    for i in range(len(clipper)):
        a, b = clipper[i], clipper[(i + 1) % len(clipper)]
        src, out = out, []
        for j in range(len(src)):
            p, q = src[j], src[(j + 1) % len(src)]
            if inside(q, a, b):
                if not inside(p, a, b):
                    out.append(meet(p, q, a, b))
                out.append(q)
            elif inside(p, a, b):
                out.append(meet(p, q, a, b))
        if not out:
            break
    return out


def mark(cut=0.8, writing=True, seg=16):
    """The mark as subpaths: (points, +1 to fill or -1 to cut, kind, spec)."""
    X0, Y0 = 12 - L / 2, 12 - R - T / 2
    face = (X0 + cut / 2, Y0 + cut / 2, L - cut, T - cut, RR - cut / 2)      # the card, its edge cut
    reach = (X0 - cut / 2, Y0 - cut / 2, L + cut, T + cut, RR + cut / 2)     # the card and the cut round it
    lines = [(X0 + 1.4, Y0 + 1.45, L * 0.52, 0.85), (X0 + 1.4, Y0 + 2.85, L * 0.33, 0.85)]
    out = []
    for i in range(N):
        a = i * 360 / N
        card = [rot(p, a) for p in rrect(*face, seg=seg)]
        out.append((card, +1, 'card', (face, a)))
        # The next card round lies on this one: take its edge out of this card.
        nxt = [rot(p, a + 360 / N) for p in rrect(*reach, seg=seg)]
        bite = clip(card, nxt)
        if len(bite) >= 3:
            out.append((bite[::-1] if signed_area(bite) > 0 else bite, -1, 'poly', None))
        if writing:
            for (lx, ly, lw, lh) in lines:
                hole = [rot(p, a) for p in rrect(lx, ly, lw, lh, lh / 2, seg=seg)]
                out.append((hole[::-1], -1, 'rrect', ((lx, ly, lw, lh, lh / 2), a)))
    out.append((circle(12, 12, HUB), +1, 'circle', (12, 12, HUB)))
    out.append((circle(12, 12, HOLE)[::-1], -1, 'circle', (12, 12, HOLE)))
    return out


FULL = dict(cut=0.8, writing=True)
SMALL = dict(cut=1.3, writing=False)


# ---- the path, for CSS and the site ---------------------------------------------
def n(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def simplify(pts, tol=0.015):
    """Douglas-Peucker on a closed ring, so a bite stays a handful of points."""
    if len(pts) < 4:
        return pts

    def dp(seq):
        if len(seq) < 3:
            return seq
        a, b = seq[0], seq[-1]
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy) or 1e-9
        far, k = -1.0, 0
        for i in range(1, len(seq) - 1):
            d = abs(dy * seq[i][0] - dx * seq[i][1] + b[0] * a[1] - b[1] * a[0]) / ln
            if d > far:
                far, k = d, i
        if far <= tol:
            return [a, b]
        return dp(seq[:k + 1])[:-1] + dp(seq[k:])

    k = max(range(len(pts)), key=lambda i: math.dist(pts[0], pts[i]))
    return dp(pts[:k + 1])[:-1] + dp(pts[k:] + [pts[0]])[:-1]


def rrect_d(spec, a, sweep):
    """A turned rounded rectangle as M/L/A, clockwise (sweep 1) or not (sweep 0)."""
    x, y, w, h, r = spec
    pts = [(x + r, y), (x + w - r, y), (x + w, y + r), (x + w, y + h - r), (x + w - r, y + h), (x + r, y + h), (x, y + h - r), (x, y + r)]
    q = [rot(p, a) for p in pts]
    rr = n(r)
    if sweep:
        # top edge, corner, right edge, corner, bottom, corner, left, corner
        d = 'M%s %sL%s %sA%s %s 0 0 1 %s %sL%s %sA%s %s 0 0 1 %s %sL%s %sA%s %s 0 0 1 %s %sL%s %sA%s %s 0 0 1 %s %sZ' % (
            n(q[0][0]), n(q[0][1]), n(q[1][0]), n(q[1][1]), rr, rr, n(q[2][0]), n(q[2][1]),
            n(q[3][0]), n(q[3][1]), rr, rr, n(q[4][0]), n(q[4][1]),
            n(q[5][0]), n(q[5][1]), rr, rr, n(q[6][0]), n(q[6][1]),
            n(q[7][0]), n(q[7][1]), rr, rr, n(q[0][0]), n(q[0][1]))
    else:
        # the same ring walked the other way: start top-left, go down the left side
        w_ = [(x + r, y), (x, y + r), (x, y + h - r), (x + r, y + h), (x + w - r, y + h), (x + w, y + h - r), (x + w, y + r), (x + w - r, y)]
        q = [rot(p, a) for p in w_]
        d = 'M%s %sA%s %s 0 0 0 %s %sL%s %sA%s %s 0 0 0 %s %sL%s %sA%s %s 0 0 0 %s %sL%s %sA%s %s 0 0 0 %s %sZ' % (
            n(q[0][0]), n(q[0][1]), rr, rr, n(q[1][0]), n(q[1][1]),
            n(q[2][0]), n(q[2][1]), rr, rr, n(q[3][0]), n(q[3][1]),
            n(q[4][0]), n(q[4][1]), rr, rr, n(q[5][0]), n(q[5][1]),
            n(q[6][0]), n(q[6][1]), rr, rr, n(q[7][0]), n(q[7][1]))
    return d


def path_d(parts):
    d = []
    for pts, sign, kind, spec in parts:
        if kind in ('card', 'rrect'):
            (rect, a) = spec
            d.append(rrect_d(rect, a, 1 if sign > 0 else 0))
        elif kind == 'circle':
            cx, cy, r = spec
            s = 1 if sign > 0 else 0
            d.append('M%s %sA%s %s 0 1 %d %s %sA%s %s 0 1 %d %s %sZ' % (n(cx - r), n(cy), n(r), n(r), s, n(cx + r), n(cy), n(r), n(r), s, n(cx - r), n(cy)))
        else:
            q = simplify(pts)
            d.append('M' + 'L'.join('%s %s' % (n(x), n(y)) for x, y in q) + 'Z')
    return ''.join(d)


# ---- filling: nonzero, scanline ---------------------------------------------------
def winding_at(edges, p):
    w = 0
    for (x0, y0), (x1, y1) in edges:
        if y0 <= p[1] < y1 and (x1 - x0) * (p[1] - y0) - (p[0] - x0) * (y1 - y0) > 0:
            w += 1
        elif y1 <= p[1] < y0 and (x1 - x0) * (p[1] - y0) - (p[0] - x0) * (y1 - y0) < 0:
            w -= 1
    return w


def check(cut, writing):
    """The path must equal the drawing it stands for: a point is ink if it is on a
    card face, not in the writing, and not under the edge of the next card; or on
    the hub and not in its hole. Sampled on a fine grid."""
    parts = mark(cut, writing, seg=24)
    X0, Y0 = 12 - L / 2, 12 - R - T / 2

    def in_rr(p, x, y, w, h, r, a):
        q = rot(p, -a)
        cx, cy = min(max(q[0], x + r), x + w - r), min(max(q[1], y + r), y + h - r)
        return math.hypot(q[0] - cx, q[1] - cy) <= r

    def ink(p):
        if HOLE < math.dist(p, (12, 12)) <= HUB:
            return True
        for i in range(N):
            a = i * 360 / N
            if not in_rr(p, X0 + cut / 2, Y0 + cut / 2, L - cut, T - cut, RR - cut / 2, a):
                continue
            if in_rr(p, X0 - cut / 2, Y0 - cut / 2, L + cut, T + cut, RR + cut / 2, a + 360 / N):
                continue
            if writing and any(in_rr(p, lx, ly, lw, lh, lh / 2, a) for lx, ly, lw, lh in ((X0 + 1.4, Y0 + 1.45, L * 0.52, 0.85), (X0 + 1.4, Y0 + 2.85, L * 0.33, 0.85))):
                continue
            return True
        return False

    edges = edges_of([pts for pts, _, _, _ in parts])

    def near(p):
        def d(a, b):
            dx, dy = b[0] - a[0], b[1] - a[1]
            t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy or 1.0)))
            return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
        return min(d(a, b) for a, b in edges)

    bad = 0
    steps = 200
    for j in range(steps):
        py = (j + 0.61) * 24 / steps
        row = [e for e in edges if min(e[0][1], e[1][1]) <= py < max(e[0][1], e[1][1])]
        for i in range(steps):
            p = ((i + 0.37) * 24 / steps, py)
            if ink(p) != (winding_at(row, p) != 0) and near(p) > 0.01:
                bad += 1   # a miss on the very edge is only the flattening of a curve
    return bad


def add_span(cov, x0, x1, w):
    if x1 <= x0:
        return
    x0, x1 = max(x0, 0.0), min(x1, float(w))
    if x1 <= x0:
        return
    i0, i1 = int(x0), int(math.ceil(x1)) - 1
    if i0 == i1:
        cov[i0] += (x1 - x0)
        return
    cov[i0] += (i0 + 1 - x0)
    for i in range(i0 + 1, i1):
        cov[i] += 1.0
    cov[i1] += (x1 - i1)


def coverage(edges, y, w, sub=4):
    """Coverage of one pixel row, nonzero, `sub` vertical subsamples."""
    cov = [0.0] * w
    for k in range(sub):
        sy = y + (k + 0.5) / sub
        xs = []
        for (ax, ay), (bx, by) in edges:
            if ay <= sy < by:
                xs.append((ax + (sy - ay) * (bx - ax) / (by - ay), 1))
            elif by <= sy < ay:
                xs.append((ax + (sy - ay) * (bx - ax) / (by - ay), -1))
        xs.sort()
        wind, start = 0, 0.0
        for x, d in xs:
            if wind == 0:
                start = x
            wind += d
            if wind == 0:
                add_span(cov, start, x, w)
    return [c / sub for c in cov]


def edges_of(polys):
    out = []
    for pts in polys:
        out += [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]
    return out


# ---- the icon -------------------------------------------------------------------
W = H = 1024
# macOS proportions: an 832 square inset in a 1024 canvas, Big Sur corner.
TILE_X, TILE_Y, TILE_W, TILE_H, TILE_R = 96.0, 96.0, 832.0, 832.0, 186.0
GROUND_TOP = (0xFF, 0xD8, 0x3E)   # the app's yellow, a touch lighter at the top
GROUND_BOT = (0xF7, 0xC4, 0x1A)   # and a touch deeper at the foot
INK = (0x24, 0x1F, 0x0E)          # --on-banana
EDGE_ALPHA = 0.16                 # a hairline so the tile holds on a light Dock
SCALE = 21.3                      # 24 units -> 511px, the share of the tile the boards were drawn at


def png(path, rows, w, h):
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def tile_polys(inset=0.0):
    return [rrect(TILE_X + inset, TILE_Y + inset, TILE_W - 2 * inset, TILE_H - 2 * inset, TILE_R - inset, seg=48)]


def main(path):
    for name, spec in (('full', FULL), ('small', SMALL)):
        bad = check(**spec)
        if bad:
            sys.exit(f'the {name} path does not match its drawing at {bad} sample points')

    parts = mark(**FULL, seg=24)
    k = SCALE
    mark_polys = [[(512 + (x - 12) * k, 512 + (y - 12) * k) for x, y in pts] for pts, _, _, _ in parts]
    mark_edges = edges_of(mark_polys)
    tile_edges, inner_edges = edges_of(tile_polys()), edges_of(tile_polys(4.0))

    rows = []
    for y in range(H):
        tile = coverage(tile_edges, y, W)
        inner = coverage(inner_edges, y, W)
        ink = coverage(mark_edges, y, W) if 512 - 12 * k <= y <= 512 + 12 * k else [0.0] * W
        gt = min(max((y - TILE_Y) / TILE_H, 0.0), 1.0)
        base = tuple(GROUND_TOP[j] + (GROUND_BOT[j] - GROUND_TOP[j]) * gt for j in range(3))
        row = bytearray(b"\x00")
        for x in range(W):
            a = tile[x]
            if a <= 0.0:
                row += b"\x00\x00\x00\x00"
                continue
            r, g, b = base
            e = (a - inner[x]) * EDGE_ALPHA
            if e > 0.0:
                r, g, b = r + (INK[0] - r) * e, g + (INK[1] - g) * e, b + (INK[2] - b) * e
            m = min(ink[x], 1.0)
            if m > 0.0:
                r, g, b = r + (INK[0] - r) * m, g + (INK[1] - g) * m, b + (INK[2] - b) * m
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a * 255 + 0.5)))
        rows.append(bytes(row))
    size = png(path, rows, W, H)
    print(f"wrote {path}  {W}x{H}  {size} bytes")
    print("\nfull mark (24-unit box, fill-rule nonzero):\n" + path_d(mark(**FULL)))
    print("\nsmall mark:\n" + path_d(mark(**SMALL)))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "app-icon.png")
