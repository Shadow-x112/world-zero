# Builds the 3D shapes of what the AIs build with, in Blender, for the viewer:
#   python3 tools/build_pieces.py  ->  src/viewer/pieces.glb   (needs: pip install bpy)
#
# Every piece in the world is one of four forms (see src/building/pieces.ts), and the
# viewer stretches a shape to each piece's own length, width and thickness. So every
# shape here fills a unit box, centred on the origin:
#   x  along its length     (-0.5 .. 0.5)
#   y  across its width     (-0.5 .. 0.5)   (glTF: -z)
#   z  through its thickness(-0.5 .. 0.5)   (glTF: y)
#
#   pole*   a six-sided rod, a little tapered and knotted
#   stone*  a lump, roughly dressed (squarer than the stones lying wild, so walls read as built)
#   slab*   a flat sheet with chipped edges
#   mat*    a woven panel, gently rippled
#
# uv: x = along the length (0..1), y = across the width (0..1); the shader draws the weave
# of mats and the grain of poles from it.

import math
import random
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, noise

OUT = Path(__file__).resolve().parent.parent / "src" / "viewer" / "pieces.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)


def finish(name, bm, smooth=False, dissolve=0.0):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if dissolve:
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(dissolve), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    # Fit the unit box exactly.
    lo = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
    hi = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
    size = hi - lo
    mid = (hi + lo) / 2
    for v in bm.verts:
        v.co = Vector(((v.co.x - mid.x) / size.x, (v.co.y - mid.y) / size.y, (v.co.z - mid.z) / size.z))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    uv = me.uv_layers.new(name="uv")
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (co.x + 0.5, co.y + 0.5)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def pole(name, seed):
    """A six-sided rod: tapering a little, a knot or two along it, ends cut at a slight slant."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    rings = 10
    sides = 6
    knots = [rnd.uniform(0.2, 0.8) for _ in range(rnd.randint(1, 2))]
    twist = rnd.uniform(-0.4, 0.4)
    verts = []
    for i in range(rings + 1):
        t = i / rings
        x = t - 0.5
        r = 0.5 * (1.0 - 0.18 * t)  # thicker at the butt
        for k in knots:
            r *= 1.0 + 0.12 * math.exp(-((t - k) / 0.04) ** 2)
        ring = []
        for s in range(sides):
            a = 2 * math.pi * s / sides + twist * t
            ring.append(bm.verts.new((x + (0.02 * math.sin(a) if i in (0, rings) else 0), r * math.cos(a), r * math.sin(a))))
        verts.append(ring)
    for i in range(rings):
        for s in range(sides):
            a, b = verts[i][s], verts[i][(s + 1) % sides]
            c, d = verts[i + 1][(s + 1) % sides], verts[i + 1][s]
            bm.faces.new((a, b, c, d))
    bm.faces.new(list(reversed(verts[0])))
    bm.faces.new(verts[-1])
    return finish(name, bm, smooth=False)


def lump(name, seed, square):
    """A stone: a cube pushed toward a sphere and roughened, then cut into facets."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=3, use_grid_fill=True)
    off = Vector((rnd.uniform(0, 50), rnd.uniform(0, 50), rnd.uniform(0, 50)))
    for v in bm.verts:
        c = v.co.copy()
        round_ = c.normalized() * 0.5 * math.sqrt(3) * 0.62
        c = c.lerp(round_, 1 - square)
        n = noise.noise(c * 2.2 + off)
        c *= 1.0 + 0.2 * n
        v.co = c
    return finish(name, bm, smooth=False, dissolve=28)


def slab(name, seed):
    """A flat sheet, its outline chipped."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    n = 14
    top, bot = [], []
    for i in range(n):
        a = 2 * math.pi * i / n + rnd.uniform(-0.1, 0.1)
        # A rounded rectangle, notched here and there.
        x, y = math.cos(a), math.sin(a)
        k = max(abs(x), abs(y)) or 1
        r = rnd.uniform(0.85, 1.0)
        px, py = x / k * 0.5 * r, y / k * 0.5 * r
        tz = 0.5 + rnd.uniform(-0.12, 0.0)
        bz = -0.5 + rnd.uniform(0.0, 0.12)
        top.append(bm.verts.new((px, py, tz)))
        bot.append(bm.verts.new((px * rnd.uniform(0.94, 1.0), py * rnd.uniform(0.94, 1.0), bz)))
    bm.faces.new(top)
    bm.faces.new(list(reversed(bot)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    return finish(name, bm, smooth=False)


def mat(name, seed):
    """A woven panel: a thin sheet, rippled along its weave, edges a little ragged."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    nx, ny = 16, 10
    grid = []
    for side, z0 in (("top", 0.5), ("bottom", -0.5)):
        rows = []
        for j in range(ny + 1):
            row = []
            for i in range(nx + 1):
                u, v = i / nx, j / ny
                x, y = u - 0.5, v - 0.5
                edge = 1 if i in (0, nx) or j in (0, ny) else 0
                x += edge * rnd.uniform(-0.01, 0.01)
                y += edge * rnd.uniform(-0.01, 0.01)
                z = z0 * 0.6 + 0.4 * math.sin(u * math.pi * 6 + 0.7 * math.sin(v * math.pi * 3)) * 0.5
                row.append(bm.verts.new((x, y, z)))
            rows.append(row)
        grid.append(rows)
    top, bot = grid
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((top[j][i], top[j][i + 1], top[j + 1][i + 1], top[j + 1][i]))
            bm.faces.new((bot[j][i], bot[j + 1][i], bot[j + 1][i + 1], bot[j][i + 1]))
    # Close the rim.
    rim = [(j, 0) for j in range(ny)] + [(ny, i) for i in range(nx)] + [(j, nx) for j in range(ny, 0, -1)] + [(0, i) for i in range(nx, 0, -1)]
    for k in range(len(rim)):
        (j1, i1), (j2, i2) = rim[k], rim[(k + 1) % len(rim)]
        bm.faces.new((top[j1][i1], top[j2][i2], bot[j2][i2], bot[j1][i1]))
    return finish(name, bm, smooth=True)


pole("pole0", 1)
pole("pole1", 2)
lump("stone0", 11, 0.5)
lump("stone1", 12, 0.35)
lump("stone2", 13, 0.6)
slab("slab0", 21)
slab("slab1", 22)
mat("mat0", 31)

bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", export_apply=True, export_yup=True, export_materials="NONE")
print("wrote", OUT, OUT.stat().st_size, "bytes")
