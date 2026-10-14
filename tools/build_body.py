# Builds the AIs' body in Blender and exports it for the viewer:
#   python3 tools/build_body.py  ->  src/viewer/body.glb   (needs: pip install bpy)
#
# One continuous, smooth surface grown over a skeleton (Blender's skin modifier, then
# subdivided): a tall glass body on bird-like legs, a lens-shaped head floating just
# above the shoulders, and five tendrils (two at the shoulders that serve as arms, three
# arching from the back). Bones follow the same skeleton; every vertex is weighted to the
# nearest bones of its own limb so the surface bends smoothly.
#
# Two extra coordinate sets go to the viewer's shader:
#   uv   (cos, sin) of the angle around the limb at that point (for lines of light that
#        run along the body; stored as cos/sin so they never wrap)
#   uv1  (distance from the chest, part + how far along its limb)
#        parts: 0 body, 1 leg, 2 arm tendril, 3 back tendril, 4 head

import math
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector

OUT = Path(__file__).resolve().parent.parent / "src" / "viewer" / "body.glb"

bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- The skeleton: chains of points (Blender: Z up, the body faces -Y) ----------
# Each point: (x, y, z, radius_x, radius_y)

CHEST = Vector((0, 0, 1.3))

def chain_spine():
    return [
        (0, 0.0, 0.84, 0.075, 0.06),   # pelvis
        (0, 0.0, 0.98, 0.052, 0.045),  # waist
        (0, -0.005, 1.14, 0.075, 0.055),
        (0, -0.01, 1.3, 0.1, 0.068),   # chest
        (0, -0.005, 1.42, 0.085, 0.055),
        (0, 0.0, 1.49, 0.035, 0.035),  # the top of the neck-less body
    ]

def chain_leg(s):
    return [
        (s * 0.075, 0.0, 0.84, 0.05, 0.05),
        (s * 0.085, -0.17, 0.56, 0.036, 0.036),  # knee, forward
        (s * 0.085, 0.13, 0.22, 0.024, 0.024),   # heel, back (it walks on its toes)
        (s * 0.085, 0.03, 0.035, 0.019, 0.019),  # ball of the foot
        (s * 0.085, -0.11, 0.01, 0.008, 0.008),  # toe tip
    ]

def tendril(start, ctrl, end, n, r0, r1, lift=0.0):
    """A tapering chain along a quadratic curve."""
    pts = []
    for i in range(n):
        t = i / (n - 1)
        a, b, c = Vector(start), Vector(ctrl), Vector(end)
        p = a * (1 - t) ** 2 + b * 2 * t * (1 - t) + c * t * t
        r = r0 * (1 - t) + r1 * t
        r *= 1 - 0.3 * t * t
        pts.append((p.x, p.y, p.z, r, r))
    return pts

def chain_arm(s):
    return tendril((s * 0.13, 0.0, 1.4), (s * 0.27, -0.02, 1.2), (s * 0.21, -0.07, 0.72), 11, 0.03, 0.007)

def chain_back(x, s):
    return tendril((x, 0.05, 1.43), (x + s * 0.12, 0.3, 1.9), (x + s * 0.22, 0.42, 1.18), 12, 0.024, 0.005)

CHAINS = {
    "spine": chain_spine(),
    "legL": chain_leg(1), "legR": chain_leg(-1),
    "armL": chain_arm(1), "armR": chain_arm(-1),
    "backL": chain_back(0.05, 1), "backR": chain_back(-0.05, -1), "backC": [(0, 0.06, 1.47, 0.022, 0.022)] + chain_back(0.0, 0)[1:],
}
# Where each chain hangs from: (parent chain, index into it).
PARENTS = {"legL": ("spine", 0), "legR": ("spine", 0), "armL": ("spine", 4), "armR": ("spine", 4),
           "backL": ("spine", 4), "backR": ("spine", 4), "backC": ("spine", 5)}
PART = {"spine": 0, "legL": 1, "legR": 1, "armL": 2, "armR": 2, "backL": 3, "backR": 3, "backC": 3}

# ---------- The surface, grown over the skeleton ----------

mesh = bpy.data.meshes.new("skeleton")
obj = bpy.data.objects.new("body", mesh)
bpy.context.scene.collection.objects.link(obj)
bm = bmesh.new()
skin_layer = bm.verts.layers.skin.verify()
index = {}
for name, pts in CHAINS.items():
    vs = []
    for i, (x, y, z, rx, ry) in enumerate(pts):
        if i == 0 and name in PARENTS:
            # The chain grows out of its parent: link to the parent's point.
            pc, pi = PARENTS[name]
            parent_v = index[(pc, pi)]
            v = bm.verts.new((x, y, z))
            bm.edges.new((parent_v, v))
        else:
            v = bm.verts.new((x, y, z))
            if vs:
                bm.edges.new((vs[-1], v))
        v[skin_layer].radius = (rx, ry)
        index[(name, i)] = v
        vs.append(v)
bm.verts.ensure_lookup_table()
index[("spine", 0)][skin_layer].use_root = True
bm.to_mesh(mesh)
bm.free()

bpy.context.view_layer.objects.active = obj
obj.select_set(True)
skin = obj.modifiers.new("skin", "SKIN")
skin.use_smooth_shade = True
skin.branch_smoothing = 0.6
sub = obj.modifiers.new("smooth", "SUBSURF")
sub.levels = 1
sub.render_levels = 1
bpy.ops.object.modifier_apply(modifier="skin")
bpy.ops.object.modifier_apply(modifier="smooth")
bpy.ops.object.shade_smooth()

# ---------- The head: a smooth lens, floating just above and ahead of the shoulders ----------

bpy.ops.mesh.primitive_uv_sphere_add(segments=28, ring_count=18, radius=1, location=(0, 0, 0))
head = bpy.context.active_object
head.name = "head"
hm = head.data
for v in hm.vertices:
    x, y, z = v.co
    # A teardrop lens: rounded at the back of the skull, drawn out to a point in front
    # (-y), a little taller than it is wide.
    front = max(0.0, -y)
    taper = 1 - 0.55 * front ** 1.6
    v.co = Vector((x * 0.058 * taper, y * (0.085 + 0.06 * front), z * 0.066 * taper))
head.location = (0, -0.035, 1.6)
head.rotation_euler = (math.radians(8), 0, 0)  # nose a little down
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.shade_smooth()

# Join into one mesh, remembering which vertices are the head.
n_body = len(obj.data.vertices)
bpy.ops.object.select_all(action="DESELECT")
head.select_set(True)
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.join()
me = obj.data
n_all = len(me.vertices)
is_head = np.zeros(n_all, bool)
is_head[n_body:] = True

# ---------- Bones ----------

arm_data = bpy.data.armatures.new("rig")
rig = bpy.data.objects.new("rig", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
bones = []  # (name, chain, i, head, tail)
for name, pts in CHAINS.items():
    start_parent = None
    if name in PARENTS:
        pc, pi = PARENTS[name]
        start_parent = f"{pc}{pi}" if pi < len(CHAINS[pc]) - 1 else f"{pc}{pi - 1}"
    prev = None
    for i in range(len(pts) - 1):
        bname = f"{name}{i}"
        b = eb.new(bname)
        b.head = Vector(pts[i][:3])
        b.tail = Vector(pts[i + 1][:3])
        b.roll = 0
        if prev is not None:
            b.parent = eb[prev]
            b.use_connect = True
        elif start_parent:
            b.parent = eb[start_parent]
        prev = bname
        bones.append((bname, name, i, Vector(pts[i][:3]), Vector(pts[i + 1][:3])))
hb = eb.new("head")
hb.head = Vector((0, 0, 1.49))
hb.tail = Vector((0, 0, 1.62))
hb.parent = eb["spine4"]
bpy.ops.object.mode_set(mode="OBJECT")

# ---------- Weights: each vertex to the nearest bones of its own limb ----------

co = np.array([v.co[:] for v in me.vertices])
H = np.array([b[3][:] for b in bones])
T = np.array([b[4][:] for b in bones])
D = T - H
L2 = (D * D).sum(1)
rel = co[:, None, :] - H[None, :, :]
t = np.clip((rel * D[None]).sum(2) / L2[None], 0, 1)
closest = H[None] + t[..., None] * D[None]
dist = np.linalg.norm(co[:, None, :] - closest, axis=2)

groups = {b[0]: obj.vertex_groups.new(name=b[0]) for b in bones}
groups["head"] = obj.vertex_groups.new(name="head")
chain_of = [b[1] for b in bones]
idx_in_chain = [b[2] for b in bones]

uv_angle = np.zeros((n_all, 2))
uv_info = np.zeros((n_all, 2))

# Distance from the chest along the body, at the start of each chain.
def chain_len(pts, upto):
    return sum((Vector(pts[k + 1][:3]) - Vector(pts[k][:3])).length for k in range(upto))

for vi in range(n_all):
    if is_head[vi]:
        groups["head"].add([vi], 1.0, "REPLACE")
        hc = co[vi] - np.array([0, -0.035, 1.6])
        uv_angle[vi] = (hc[0] / 0.07, hc[2] / 0.05)  # the head's own across / up
        uv_info[vi] = (0.0, 4.0 + 0.5)
        continue
    d = dist[vi]
    best = int(np.argmin(d))
    ch = chain_of[best]
    # Candidates: the best bone and its neighbours in the same chain (and where a chain
    # meets its parent, the parent's bone, so joints blend).
    cand = [k for k in range(len(bones)) if chain_of[k] == ch and abs(idx_in_chain[k] - idx_in_chain[best]) <= 1]
    if idx_in_chain[best] == 0 and ch in PARENTS:
        pc, pi = PARENTS[ch]
        pname = f"{pc}{min(pi, len(CHAINS[pc]) - 2)}"
        cand.append(next(k for k in range(len(bones)) if bones[k][0] == pname))
    w = np.array([1.0 / (d[k] + 0.004) ** 4 for k in cand])
    w /= w.sum()
    order = np.argsort(-w)[:3]
    ws = w[order] / w[order].sum()
    for k, wk in zip(order, ws):
        if wk > 0.01:
            groups[bones[cand[k]][0]].add([vi], float(wk), "REPLACE")
    # Around the limb: the angle against a reference across it (front for upright parts).
    axis = D[best] / math.sqrt(L2[best])
    ref = np.array([0, -1.0, 0]) if abs(axis[1]) < 0.8 else np.array([1.0, 0, 0])
    ref = ref - axis * (ref @ axis)
    ref /= np.linalg.norm(ref)
    side = np.cross(axis, ref)
    radial = co[vi] - closest[vi, best]
    a = math.atan2(radial @ side, radial @ ref)
    uv_angle[vi] = (math.cos(a), math.sin(a))
    # Along the body: distance from the chest, and how far along its limb.
    pts = CHAINS[ch]
    along = chain_len(pts, idx_in_chain[best]) + t[vi, best] * math.sqrt(L2[best])
    total = chain_len(pts, len(pts) - 1)
    if ch == "spine":
        from_chest = abs(co[vi][2] - CHEST.z)
    else:
        base = CHAINS[PARENTS[ch][0]][PARENTS[ch][1]]
        from_chest = abs(base[2] - CHEST.z) + along
    uv_info[vi] = (from_chest, PART[ch] + 0.98 * along / total)

# Write the coordinate sets per face corner.
while me.uv_layers:
    me.uv_layers.remove(me.uv_layers[0])
me.uv_layers.new(name="angle")
me.uv_layers.new(name="info")
for poly in me.polygons:
    for li in poly.loop_indices:
        vi = me.loops[li].vertex_index
        me.uv_layers["angle"].data[li].uv = uv_angle[vi]
        me.uv_layers["info"].data[li].uv = uv_info[vi]

# ---------- Bind and export ----------

obj.parent = rig
mod = obj.modifiers.new("rig", "ARMATURE")
mod.object = rig
print(f"vertices {len(me.vertices)}, triangles {sum(len(p.vertices) - 2 for p in me.polygons)}, bones {len(bones) + 1}")

bpy.ops.object.select_all(action="DESELECT")
obj.select_set(True)
rig.select_set(True)
OUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUT),
    export_format="GLB",
    use_selection=True,
    export_skins=True,
    export_animations=False,
    export_normals=True,
    export_texcoords=True,
    export_materials="NONE",
    export_yup=True,
    export_apply=False,
)
print("wrote", OUT, OUT.stat().st_size, "bytes")
