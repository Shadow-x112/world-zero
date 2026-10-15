# Builds the 3D shapes of what lies on the land, in Blender, for the viewer:
#   python3 tools/build_resources.py  ->  src/viewer/resources.glb   (needs: pip install bpy)
#
# Every material is drawn by how it looks (never by what it is): growing things as
# plants, heavy things as stones, glowing things as crystals. Several variants of each,
# so a field never looks stamped out. Sizes are normalized (the viewer scales each
# piece by how much is left):
#   plant*    1.0 tall, base at the origin
#   stone*    0.42 tall, resting on the origin
#   crystal*  0.62 tall, centred so it can float and turn about its middle
#
# uv: x = across a blade (0..1; 2 marks a seed-pod), y = height through the piece (0..1).

import math
import random
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, Matrix, noise

OUT = Path(__file__).resolve().parent.parent / "src" / "viewer" / "resources.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)


def new_object(name, bm, smooth, dissolve=0.0):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if dissolve:
        # Merge nearly flat neighbours into larger facets (a cut-stone look).
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(dissolve), verts=bm.verts, edges=bm.edges)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def set_uv(obj, fn):
    """fn(vertex co, polygon) -> (u, v), per face corner."""
    me = obj.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    uv = me.uv_layers.new(name="uv")
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uv.data[li].uv = fn(me.vertices[vi].co, poly, vi)


# ---------- Plants ----------

def blade(bm, base, yaw, lean, length, width, bend, segs=6, fold=0.25, tags=None):
    """A curved, tapering blade with a raised midrib (three vertices across)."""
    rows = []
    d = Vector((math.cos(yaw), math.sin(yaw), 0))  # outward
    side = Vector((-d.y, d.x, 0))
    p = Vector(base)
    for i in range(segs + 1):
        t = i / segs
        ang = lean + bend * t * t  # angle from vertical, growing toward the tip
        up = Vector((0, 0, 1)) * math.cos(ang) + d * math.sin(ang)
        if i > 0:
            p = p + up * (length / segs)
        w = width * (1 - t) ** 0.8 * (0.6 + 0.4 * math.sin(math.pi * min(1, t * 1.6 + 0.2)))
        normal = up.cross(side).normalized()
        left = p - side * w
        right = p + side * w
        mid = p + normal * (w * fold)
        rows.append((bm.verts.new(left), bm.verts.new(mid), bm.verts.new(right)))
        if tags is not None:
            tags.extend([(rows[-1][0], 0.0), (rows[-1][1], 0.5), (rows[-1][2], 1.0)])
    for a, b in zip(rows, rows[1:]):
        bm.faces.new((a[0], a[1], b[1], b[0]))
        bm.faces.new((a[1], a[2], b[2], b[1]))


# ---------- Stones ----------

def rock(bm, center, radius, squash, seed):
    ret = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=radius)
    verts = ret["verts"]
    rnd = random.Random(seed)
    off = Vector((rnd.uniform(0, 50), rnd.uniform(0, 50), rnd.uniform(0, 50)))
    for v in verts:
        n = noise.noise(v.co * (2.2 / radius) + off)
        v.co *= 1 + 0.3 * n
        v.co.x *= rnd.uniform(0.85, 1.15)
        v.co.z *= squash
        v.co += Vector(center)
        if v.co.z < 0:
            v.co.z *= 0.2  # sits on the ground


def stone(name, seed, layout):
    bm = bmesh.new()
    rnd = random.Random(seed)
    for (x, y, r, sq) in layout:
        rock(bm, (x, y, r * sq * 0.55), r, sq, rnd.randint(0, 9999))
    obj = new_object(name, bm, smooth=False, dissolve=24)
    me = obj.data
    zmax = max(v.co.z for v in me.vertices)
    s = 0.42 / zmax
    for v in me.vertices:
        v.co *= s
    set_uv(obj, lambda co, poly, vi: (0.0, max(0.0, min(1.0, co.z / 0.42))))
    return obj


# ---------- Crystals ----------

def crystal(bm, base, axis, length, radius, tip=0.32, double=True, twist=0.0):
    """A six-sided crystal: a prism with a pointed end (or both ends pointed)."""
    axis = Vector(axis).normalized()
    ref = Vector((1, 0, 0)) if abs(axis.x) < 0.9 else Vector((0, 1, 0))
    u = axis.cross(ref).normalized()
    w = axis.cross(u)
    base = Vector(base)
    body = length * (1 - tip * (2 if double else 1))
    start = base + axis * (length * tip if double else 0)
    ring0, ring1 = [], []
    for i in range(6):
        a = twist + i / 6 * math.tau
        off = (u * math.cos(a) + w * math.sin(a)) * radius
        ring0.append(bm.verts.new(start + off * (1.0 if double else 1.08)))
        ring1.append(bm.verts.new(start + axis * body + off * 0.94))
    top = bm.verts.new(start + axis * (body + length * tip))
    for i in range(6):
        j = (i + 1) % 6
        bm.faces.new((ring0[i], ring0[j], ring1[j], ring1[i]))
        bm.faces.new((ring1[i], ring1[j], top))
    if double:
        bottom = bm.verts.new(base)
        for i in range(6):
            j = (i + 1) % 6
            bm.faces.new((ring0[j], ring0[i], bottom))
    else:
        bm.faces.new(list(reversed(ring0)))


def crystal_obj(name, kind):
    bm = bmesh.new()
    if kind == 0:
        # One tall double-pointed crystal, with two small shards beside it.
        crystal(bm, (0, 0, -0.5), (0, 0, 1), 1.0, 0.12)
        crystal(bm, (0.2, 0.05, -0.2), (0.15, 0.05, 1), 0.38, 0.045, twist=0.4)
        crystal(bm, (-0.17, -0.1, -0.05), (-0.1, -0.1, 1), 0.3, 0.035, twist=1.0)
    else:
        # A cluster of three, fused at the root, fanning out.
        for (ax, l, r, tw) in [((0, 0, 1), 1.0, 0.1, 0.0), ((0.45, 0.1, 1), 0.75, 0.08, 0.5), ((-0.35, 0.3, 1), 0.65, 0.075, 1.1), ((0.05, -0.45, 1), 0.55, 0.065, 0.3)]:
            crystal(bm, (0, 0, -0.45), ax, l, r, double=False, tip=0.28, twist=tw)
    obj = new_object(name, bm, smooth=False)
    me = obj.data
    zmin = min(v.co.z for v in me.vertices)
    zmax = max(v.co.z for v in me.vertices)
    s = 0.62 / (zmax - zmin)
    for v in me.vertices:
        v.co.z = (v.co.z - zmin) * s - 0.62 * 0.4
        v.co.x *= s
        v.co.y *= s
    set_uv(obj, lambda co, poly, vi: (0.0, (co.z + 0.62 * 0.4) / 0.62))
    return obj


# ---------- Build everything ----------

objs = []
for k in range(3):
    random.seed(100 + k)
    bm = bmesh.new()
    across = []
    if k == 0:
        for i in range(7):
            yaw = i / 7 * math.tau + random.uniform(-0.3, 0.3)
            blade(bm, (random.uniform(-0.03, 0.03), random.uniform(-0.03, 0.03), 0), yaw,
                  random.uniform(0.1, 0.35), random.uniform(0.65, 1.0), random.uniform(0.025, 0.035),
                  random.uniform(0.5, 1.1), tags=across)
    elif k == 1:
        for i in range(5):
            yaw = i / 5 * math.tau + random.uniform(-0.2, 0.2)
            blade(bm, (0, 0, 0), yaw, random.uniform(0.25, 0.45), random.uniform(0.6, 0.8),
                  random.uniform(0.07, 0.09), random.uniform(0.7, 1.2), fold=0.35, tags=across)
    else:
        for i in range(4):
            yaw = i / 4 * math.tau + random.uniform(-0.3, 0.3)
            blade(bm, (0, 0, 0), yaw, random.uniform(0.3, 0.5), random.uniform(0.4, 0.55),
                  0.04, random.uniform(0.8, 1.3), tags=across)
        blade(bm, (0, 0, 0), 0.4, 0.05, 0.92, 0.018, 0.25, segs=8, fold=0.5, tags=across)
    bm.verts.index_update()
    tagmap = {v.index: u for v, u in across}
    top = max(bm.verts, key=lambda v: v.co.z).co.copy() if k == 2 else None
    me = bpy.data.meshes.new(f"plant{k}")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new(f"plant{k}", me)
    bpy.context.scene.collection.objects.link(obj)
    zmax = max(v.co.z for v in me.vertices)
    if k == 2:
        # The seed-pod at the top of the stalk.
        pod_bm = bmesh.new()
        ret = bmesh.ops.create_uvsphere(pod_bm, u_segments=10, v_segments=7, radius=0.045)
        for v in ret["verts"]:
            v.co.z *= 1.5
            v.co += top
        base = len(me.vertices)
        tmp = bpy.data.meshes.new("pod")
        pod_bm.to_mesh(tmp)
        pod_bm.free()
        pod_obj = bpy.data.objects.new("pod", tmp)
        bpy.context.scene.collection.objects.link(pod_obj)
        for p in tmp.polygons:
            p.use_smooth = True
        for i in range(len(tmp.vertices)):
            tagmap[base + i] = 2.0
        bpy.ops.object.select_all(action="DESELECT")
        pod_obj.select_set(True)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.join()
        me = obj.data
        zmax = max(v.co.z for v in me.vertices)
    for v in me.vertices:
        v.co *= 1.0 / zmax
    set_uv(obj, lambda co, poly, vi: (tagmap.get(vi, 0.5), max(0.0, min(1.0, co.z))))
    objs.append(obj)

objs.append(stone("stone0", 1, [(0, 0, 0.2, 1.0), (0.2, 0.08, 0.12, 0.9), (-0.14, 0.15, 0.1, 0.8)]))
objs.append(stone("stone1", 2, [(0, 0, 0.24, 0.75)]))
objs.append(stone("stone2", 3, [(-0.08, 0, 0.16, 1.1), (0.12, -0.05, 0.15, 0.9), (0.02, 0.17, 0.09, 1.0), (-0.2, -0.14, 0.07, 0.8)]))
objs.append(crystal_obj("crystal0", 0))
objs.append(crystal_obj("crystal1", 1))

for o in objs:
    me = o.data
    print(o.name, "triangles", sum(len(p.vertices) - 2 for p in me.polygons))

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", use_selection=True, export_materials="NONE",
                          export_normals=True, export_texcoords=True, export_yup=True, export_animations=False)
print("wrote", OUT, OUT.stat().st_size, "bytes")
