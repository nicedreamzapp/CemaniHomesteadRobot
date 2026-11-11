# Cemani frame v3: the rebuilt frame (11/10) from Matt's photos, with the front steering laid out.
# Run: Blender -b --factory-startup -P frame3.py -- VIEW      VIEW = iso | side | top | corner
# Front is +y (the LOW end). Tall box is the back. z=0 is the underside of the bottom rails.
import bpy, bmesh, math, json, sys, os
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

S = 0.001
OUT = "/tmp/cemani/render3"; os.makedirs(OUT, exist_ok=True)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
VIEW = argv[0] if argv else "iso"

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
LABELS = {}
def label(k, x, y, z): LABELS[k] = (x, y, z)

def mat(name, rgb, metal=0.0, rough=0.5, alpha=1.0):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    return m

RAIL = mat("rail", (0.62, 0.63, 0.66), 0.9, 0.36)      # silver 2020 like the real frame
BLKRAIL = mat("blkrail", (0.03, 0.03, 0.035), 0.5, 0.35) # the two black top rails
ALU = mat("alu", (0.72, 0.73, 0.76), 0.9, 0.3)          # gussets
NEWALU = mat("newalu", (0.70, 0.78, 0.88), 0.85, 0.3)    # new steering plates (slight blue tint so they stand out)
BLKANO = mat("blackano", (0.025, 0.025, 0.028), 0.6, 0.35)
TIRE = mat("tire", (0.035, 0.035, 0.037), 0.0, 0.75)
CHROME = mat("chrome", (0.92, 0.92, 0.94), 1.0, 0.08)
HUBSILVER = mat("hub", (0.82, 0.83, 0.85), 0.8, 0.3)
WHITE = mat("white", (0.92, 0.93, 0.95), 0.0, 0.4)
LBLUE = mat("lblue", (0.1, 0.35, 0.8), 0.0, 0.4)
BOLT = mat("bolt", (0.6, 0.6, 0.62), 1.0, 0.25)
BRASS = mat("brass", (0.85, 0.62, 0.22), 1.0, 0.3)       # bearings (so they read apart from the plates)
ACT = mat("act", (0.12, 0.12, 0.13), 0.3, 0.45)
GROUND = mat("ground", (0.93, 0.93, 0.92), 0.0, 0.9)

def link(o):
    if o.name not in sc.collection.objects: sc.collection.objects.link(o)

def box(name, cx, cy, cz, sx, sy, sz, m, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx*S, cy*S, cz*S))
    o = bpy.context.object; o.name = name
    o.scale = (sx*S, sy*S, sz*S)
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        b = o.modifiers.new("b", "BEVEL"); b.width = bevel*S; b.segments = 3
    o.data.materials.append(m)
    return o

def cyl(name, cx, cy, cz, r, h, m, axis="z", verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r*S, depth=h*S, location=(cx*S, cy*S, cz*S))
    o = bpy.context.object; o.name = name
    if axis == "x": o.rotation_euler = (0, math.pi/2, 0)
    if axis == "y": o.rotation_euler = (math.pi/2, 0, 0)
    o.data.materials.append(m)
    return o

def rod(name, p0, p1, r, m, verts=24):
    p0, p1 = Vector(p0), Vector(p1); d = p1-p0
    c = cyl(name, *((p0+p1)/2), r, d.length, m, verts=verts)
    c.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return c

def join(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    return bpy.context.object

def slab(name, pts, origin, eu, ev, thick, m, bevel=0.8):
    """flat plate: polygon pts (u,v) in mm, laid in the plane origin + u*eu + v*ev, thickness along eu x ev"""
    o0, eu, ev = Vector(origin), Vector(eu), Vector(ev); n = eu.cross(ev).normalized()
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    a = [bm.verts.new((o0 + eu*u + ev*v - n*thick/2)*S) for u, v in pts]
    b = [bm.verts.new((o0 + eu*u + ev*v + n*thick/2)*S) for u, v in pts]
    bm.faces.new(a[::-1]); bm.faces.new(b)
    k = len(pts)
    for i in range(k):
        j = (i+1) % k; bm.faces.new([a[i], a[j], b[j], b[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); link(o); me.materials.append(m)
    if bevel:
        bv = o.modifiers.new("b", "BEVEL"); bv.width = bevel*S; bv.segments = 2
    return o

def bolts(pts, origin, eu, ev, out, m=BOLT):
    o0, eu, ev = Vector(origin), Vector(eu), Vector(ev); n = Vector(out)
    for u, v in pts:
        p = o0 + eu*u + ev*v + n*1.2
        c = cyl("bolthead", p.x, p.y, p.z, 4.0, 2.4, m, verts=14)
        c.rotation_euler = n.to_track_quat("Z", "Y").to_euler()

# ---------- 2020 extrusion ----------
def profile_pts():
    h, s, d = 10, 3, 6
    pts = []
    for (ax, ay), (bx, by) in [((h, -h), (h, h)), ((h, h), (-h, h)), ((-h, h), (-h, -h)), ((-h, -h), (h, -h))]:
        dx, dy = (bx-ax)/20, (by-ay)/20; nx, ny = dy, -dx
        pts.append((ax, ay))
        for t, inset in ((10-s, 0), (10-s, d), (10+s, d), (10+s, 0)):
            pts.append((ax+dx*t - nx*inset, ay+dy*t - ny*inset))
    return pts
PROF = profile_pts()
def extr(name, length, axis, cx, cy, cz, m=RAIL):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    def P(u, v, w):
        return {"x": (w, u, v), "y": (u, w, v), "z": (u, v, w)}[axis]
    for end in (-length/2, length/2):
        for u, v in PROF: bm.verts.new(P(u*S, v*S, end*S))
    bm.verts.ensure_lookup_table(); n = len(PROF)
    bm.faces.new([bm.verts[i] for i in range(n)][::-1]); bm.faces.new([bm.verts[n+i] for i in range(n)])
    for i in range(n):
        j = (i+1) % n; bm.faces.new([bm.verts[i], bm.verts[j], bm.verts[n+j], bm.verts[n+i]])
    bm.normal_update(); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); link(o)
    o.location = (cx*S, cy*S, cz*S); me.materials.append(m)
    return o

# ================= FRAME (measured: 22 1/4 long, 12 wide, low box 6 3/4 tall, tall box 13 3/4 tall) =================
L, W = 565, 305
XR = W/2 - 10          # 142.5 side rail centre
YE = L/2 - 10          # 272.5 end rail centre
ZB, ZM, ZT = 10, 161, 339   # bottom ring, middle ring (top of the low box), top of the tall box
YT = 135               # front uprights of the tall box (tall box covers the back ~17 in)
YMID = (-160, 32)      # short uprights in the low part of each side
YIN = 190              # inner bottom cross rails, front and back
YACT = 32              # bottom cross rail the actuator bracket hangs from

for s in (-1, 1):
    extr("bottom_side", L, "y", s*XR, 0, ZB)
    extr("middle_side", L, "y", s*XR, 0, ZM)
    tl = (YT + 10) - (-L/2)
    extr("top_side_black", tl, "y", s*XR, -L/2 + tl/2, ZT, BLKRAIL)
for y in (YE, -YE):
    extr("bottom_end", W-40, "x", 0, y, ZB)
    extr("middle_end", W-40, "x", 0, y, ZM)
extr("middle_tallfront", W-40, "x", 0, YT, ZM)
extr("top_back", W-40, "x", 0, -YE, ZT)
extr("top_tallfront", W-40, "x", 0, YT, ZT)
for y in (YIN, -YIN, YACT):
    extr("inner_cross", W-40, "x", 0, y, ZB)
# uprights
for s in (-1, 1):
    extr("up_front", ZM-ZB-20, "z", s*XR, YE, (ZB+ZM)/2)
    for y in YMID:
        extr("up_mid", ZM-ZB-20, "z", s*XR, y, (ZB+ZM)/2)
    for y in (YT, -YE):
        extr("up_tall", ZT-ZB-20, "z", s*XR, y, (ZB+ZT)/2)
extr("up_backcentre", ZM-ZB-20, "z", 0, -YE, (ZB+ZM)/2)

# ---------- gussets (plates on the outside faces, like the real frame) ----------
def Lplate(c=56, w=20):   # corner plate, corner at (0,0), legs along +u and +v
    return [(0, 0), (c, 0), (c, w), (w+8, w), (w, w+8), (w, c), (0, c)]
def Tplate(a=44, b=54, w=20):  # bar along u centred, stem up +v
    return [(-a, 0), (a, 0), (a, w), (14, w+22), (10, b), (-10, b), (-14, w+22), (-a, w)]
def Xplate(a=44, w=10):   # cross plate centred on a joint
    return [(-a, -w), (-14, -w), (-10, -a), (10, -a), (14, -w), (a, -w), (a, w), (14, w), (10, a), (-10, a), (-14, w), (-a, w)]
def holes_L(c=56): return [(10, 10), (28, 10), (46, 10), (10, 28), (10, 46)]
def holes_T(a=44, b=54): return [(-34, 10), (-17, 10), (0, 10), (17, 10), (34, 10), (0, 30), (0, b-10)]
def holes_X(a=44): return [(-34, 0), (-19, 0), (19, 0), (34, 0), (0, -34), (0, -19), (0, 19), (0, 34), (0, 0)]

T = 3
for s in (-1, 1):
    xo = s*(W/2 + T/2)
    org = lambda y, z: (xo, y, z)
    out = (s, 0, 0)
    # (uy, vz) axes on the side face: u along +y or -y, v up or down
    def put(kind, y, z, du, dv):
        eu, ev = Vector((0, du, 0)), Vector((0, 0, dv))
        if kind == "L": pts, hs = Lplate(), holes_L()
        elif kind == "T": pts, hs = Tplate(), holes_T()
        else: pts, hs = Xplate(), holes_X()
        slab("gusset", pts, org(y, z), eu, ev, T, ALU)
        bolts(hs, (xo + s*T/2, y, z), eu, ev, out)
    # corners: bottom ring
    put("L", L/2, 0, -1, 1); put("L", -L/2, 0, 1, 1)
    # front corner at the middle ring (top of the low box)
    put("L", L/2, ZM+10, -1, -1)
    # back corner at the middle ring: T turned sideways (rail meets a continuing upright)
    put("L", -L/2, ZM+10, 1, -1)
    # tall box top corners
    put("L", -L/2, ZT+10, 1, -1); put("L", YT+10, ZT+10, -1, -1)
    # short uprights: T plates top and bottom
    for y in YMID:
        put("T", y, 0, 1, 1); put("T", y, ZM+10, 1, -1)
    # tall-box front upright: T at the bottom, cross plate at the middle rail
    put("T", YT, 0, 1, 1); put("X", YT, ZM, 1, 1)
label("gusset", -(W/2+3), -160, 30)
label("tallbox", -XR, -100, ZT+10)
label("lowbox", -XR, 230, ZM+10)
label("midrail", -(W/2+2), -60, ZM)
label("inner", 60, YIN, ZB+10)

# front and back faces: corner plates
for sy in (-1, 1):
    yo = sy*(L/2 + T/2)
    for s in (-1, 1):
        for z, dv in ((0, 1), (ZM+10, -1)):
            eu, ev = Vector((-s, 0, 0)), Vector((0, 0, dv))
            slab("gusset", Lplate(), (s*W/2, yo, z), eu, ev, T, ALU)
            bolts(holes_L(), (s*W/2, yo + sy*T/2, z), eu, ev, (0, sy, 0))
    if sy < 0:   # back face centre upright: T plates, and tall top corners
        for z, dv in ((0, 1), (ZM+10, -1)):
            slab("gusset", Tplate(), (0, yo, z), Vector((1, 0, 0)), Vector((0, 0, dv)), T, ALU)
            bolts(holes_T(), (0, yo - T/2, z), Vector((1, 0, 0)), Vector((0, 0, dv)), (0, -1, 0))
        for s in (-1, 1):
            slab("gusset", Lplate(), (s*W/2, yo, ZT+10), Vector((-s, 0, 0)), Vector((0, 0, -1)), T, ALU)
# flat gussets on top of the inner bottom cross rails, where they meet the side rails
for y in (YIN, -YIN, YACT):
    for s in (-1, 1):
        for dv in (1, -1):
            o = (s*(XR-10), y + dv*10, ZB+10+T/2)
            slab("gusset_flat", [(0, 0), (40, 0), (0, 40)], o, Vector((-s, 0, 0)), Vector((0, dv, 0)), T, ALU)

# ================= WHEEL (same as v2, built once and copied) =================
WR, WW = 101.5, 75
def build_wheel():
    t = cyl("tire", 0, 0, 0, WR-4.5, WW, TIRE, "x", 96)
    bpy.ops.object.transform_apply(rotation=True)
    bv = t.modifiers.new("b", "BEVEL"); bv.width = 14*S; bv.segments = 5
    bpy.context.view_layer.objects.active = t; bpy.ops.object.modifier_apply(modifier="b")
    lugs = []
    for i in range(56):
        a = 2*math.pi*i/56
        for xo in (-20, 0, 20):
            g = box("lug", xo + (4 if i % 2 else -4), (WR-4.5)*math.cos(a), (WR-4.5)*math.sin(a), 16, 2.2, 6, TIRE)
            g.rotation_euler = (a, 0, 0); lugs.append(g)
    lj = join(lugs)
    HOLE = mat("hole", (0.01, 0.01, 0.01), 0.0, 1.0)
    holes = []
    for r, n in ((88, 36), (76, 30)):
        for i in range(n):
            a = 2*math.pi*(i + (0.5 if r == 76 else 0))/n
            holes.append(cyl("h", WW/2+0.6-(1.5 if r == 88 else 0), r*math.cos(a), r*math.sin(a), 3.4, 1, HOLE, "x", 12))
    hj = join(holes)
    parts = [t, lj, hj]
    parts.append(cyl("hubring", WW/2-2, 0, 0, 66, 6, HUBSILVER, "x", 64))
    parts.append(cyl("hubcap", WW/2+1.5, 0, 0, 44, 2, WHITE, "x", 64))
    parts.append(box("band", WW/2+2.7, 0, 0, 0.6, 80, 18, LBLUE))
    bpy.ops.object.text_add(location=((WW/2+3.2)*S, 0, 0)); tx = bpy.context.object
    tx.data.body = "ZLTECH"; tx.data.size = 11*S; tx.data.align_x = "CENTER"; tx.data.align_y = "CENTER"
    tx.data.extrude = 0.3*S; tx.rotation_euler = (math.pi/2, 0, math.pi/2); tx.data.materials.append(WHITE)
    bpy.ops.object.convert(target="MESH"); parts.append(bpy.context.object)
    parts.append(cyl("hubin", -WW/2+2, 0, 0, 58, 6, HUBSILVER, "x", 64))
    parts.append(cyl("axle", -WW/2-10, 0, 0, 8, 20, BOLT, "x", 24))
    for p in parts:
        bpy.context.view_layer.objects.active = p; p.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    w = join(parts); w.name = "wheel"
    return w
WHEEL = build_wheel()

def helix(name, p0, p1, r, turns, m, wire=1.6):
    p0, p1 = Vector(p0), Vector(p1)
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"
    sp = cu.splines.new("POLY"); n = int(turns*24); sp.points.add(n)
    Ln = (p1-p0).length
    for i in range(n+1):
        a = 2*math.pi*turns*i/n
        sp.points[i].co = (r*math.cos(a)*S, r*math.sin(a)*S, (Ln*i/n)*S, 1)
    cu.bevel_depth = wire*S; cu.bevel_resolution = 3
    o = bpy.data.objects.new(name, cu); link(o); o.data.materials.append(m)
    o.location = p0*S; o.rotation_euler = (p1-p0).to_track_quat("Z", "Y").to_euler()
    return o

# ================= STEERING GEOMETRY =================
STACK = 37.5            # eared bearing + flat washer bearing + nut + new plate = about 1 1/2 in
ZP = -STACK             # top of the black plate
AXLE_DZ = 120.5         # black plate top to axle (floor to frame was 8 3/4 in before the stack)
YAX = 228.6             # half of the 18 in wheelbase
WOFF = 222.25 - XR      # wheel centre sits this far outside the pivot (17 1/2 in centre to centre)
GROUND_Z = ZP - AXLE_DZ - WR
ARM = (-17.8, -57.3)    # tie rod hole on the new plate: 2 1/4 in back, aimed at the middle of the back axle
ACTH = (-25.0, -85.0)   # actuator hole on the right plate (underneath)
ACT_PIN = Vector((-105, YACT, -45))   # actuator back pin, on a 2 in angle under the middle cross rail
PL, PR = Vector((-XR, YAX, 0)), Vector((XR, YAX, 0))

def rotz(v, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    return Vector((c*v[0] - s*v[1], s*v[0] + c*v[1], 0))
def tipL(a): return PL + rotz((-ARM[0], ARM[1]), a)     # left plate: inward is +x
def tipR(a): return PR + rotz((ARM[0], ARM[1]), a)
TIE = (tipL(0) - tipR(0)).length
def right_for(aL):   # solve the right wheel angle that keeps the tie rod length (Ackermann)
    f = lambda aR: abs((tipL(aL) - tipR(aR)).length - TIE)
    return min((aL + k*0.01 for k in range(-2000, 2001)), key=f)
def act_len(aR): return ((PR + rotz(ACTH, aR) + Vector((0, 0, -45))) - ACT_PIN).length

MAXT = 30.0
stats = {"tie_rod_mm": TIE, "right_at_left30": right_for(MAXT), "right_at_right30": None}
# turning right: right wheel is inner at -30
stats["left_at_right30"] = -right_for(MAXT)   # mirror image
lens = [act_len(right_for(MAXT)), act_len(-MAXT), act_len(right_for(0))]
stats["act_len_left_turn"], stats["act_len_right_turn"], stats["act_len_straight"] = lens
stats["stroke_used_mm"] = abs(lens[0] - lens[1])
json.dump(stats, open(f"{OUT}/steer_stats.json", "w"), indent=1)

STEER_L = 20.0 if VIEW != "side" else 0.0
STEER_R = right_for(STEER_L)

# ================= CORNERS =================
def corner(sx, sy, steer, front):
    px, py = sx*XR, sy*YAX
    # fixed to the frame
    if front:
        # eared bearing: washers under the ears, the round middle touches the rail
        for ey in (-24, 24):
            cyl("ear_washer", px, py+ey, -1.5, 6, 3, BOLT, verts=20)
            cyl("ear_bolt", px, py+ey, -14.5, 4.2, 2.6, BOLT, verts=6)
        box("eared_bearing", px, py, -8, 30, 62, 10, BRASS, bevel=4)
        cyl("bearing_round", px, py, -7.5, 15, 15, BRASS, verts=40)
        cyl("thrust", px, py, -17, 13, 4, CHROME, verts=40)
        label("eared" + ("R" if sx > 0 else "L"), px, py, -8)
        label("thrust" + ("R" if sx > 0 else "L"), px, py, -17)
    else:
        box("spacer", px, py, -STACK/2, 26, 100, STACK, ALU, bevel=1)
        if sx < 0: label("spacer", px, py - 30, -STACK/2)
    e = bpy.data.objects.new("steer", None); link(e)
    e.location = (px*S, py*S, ZP*S); e.rotation_euler = (0, 0, math.radians(steer))
    parts = []
    def add(o): o.parent = e; parts.append(o); return o
    def Lc(u, v, z): return (sx*u, sy*v, z)     # u outward, v toward the frame end, z from black plate top
    if front:
        # new 3 x 5 in plate with built-in arm (1/4 in), nut on top, flat-head bolt from below
        pts = [(-38, 32), (38, 32), (38, -70), (14, -95), (-38, -95)]
        pts = [(sx*u, sy*v) for u, v in pts]
        add(slab("steer_plate", pts, (0, 0, 6.35/2), (1, 0, 0), (0, 1, 0), 6.35, NEWALU, 0.6))
        add(cyl("nut", 0, 0, 6.35+6, 10, 12, BOLT, verts=6))
        add(cyl("bolt_head", 0, 0, -6.5, 11, 1.5, BOLT, verts=24))
        # tie rod end on top of the arm hole
        th = Lc(*ARM, 0)
        add(cyl("heim_bolt", th[0], th[1], 6.35+8, 4, 22, BOLT, verts=16))
        if sx > 0:
            ah = Lc(*ACTH, 0)
            add(cyl("act_bolt", ah[0], ah[1], -4, 4, 22, BOLT, verts=16))
    # black plate on its 4 screws
    add(box("blackplate", *Lc(-12, 0, -3), 56, 100, 6, BLKANO, bevel=1.5))
    for bu, bv in ((-30, -38), (-30, 38), (6, -38), (6, 38)):
        add(cyl("screw", *Lc(bu, bv, (6.35 if front else 0) + 1.5), 4.5, 3, BOLT, verts=16))
    # two side plates hanging down (front and back), shock between them
    up = [(-30, -6), (8, -6), (6, -150), (-20, -150)]
    for v in (-18, 18):
        add(slab("upright", [(sx*u, z) for u, z in up], (0, sy*v, 0), (1, 0, 0), (0, 0, 1), 5, BLKANO))
    # twin swing arms out to the axle block
    AX = WOFF; ZA = -AXLE_DZ
    for (u0, z0), (u1, z1) in (((-8, -100), (40, -108)), ((-8, -142), (40, -134))):
        for v in (-24, 24):
            a0, a1 = Vector((u0, z0)), Vector((u1, z1)); d = (a1-a0); n = Vector((-d.y, d.x)).normalized()*9
            ex = d.normalized()*9
            q = [a0-ex+n, a1+ex+n, a1+ex-n, a0-ex-n]
            add(slab("arm", [(sx*p.x, p.y) for p in q], (0, sy*v, 0), (1, 0, 0), (0, 0, 1), 5, BLKANO))
        add(rod("arm_pin", Lc(u0, -30, z0), Lc(u0, 30, z0), 4, BOLT))
        add(rod("arm_pin", Lc(u1, -30, z1), Lc(u1, 30, z1), 4, BOLT))
    add(box("axle_block", *Lc(40, 0, ZA), 18, 40, 52, BLKANO, bevel=2))
    # coil-over: top at the side plates, bottom on the upper arm near the wheel
    top = Vector(Lc(4, 0, -16)); bot = Vector(Lc(34, 0, -104))
    add(rod("shock_body", top, top + (bot-top)*0.62, 7.5, CHROME))
    add(rod("shock_shaft", top + (bot-top)*0.55, bot, 3.5, CHROME))
    add(helix("spring", top + (bot-top)*0.1, top + (bot-top)*0.85, 11.5, 7, CHROME, 1.7))
    add(rod("collar", top + (bot-top)*0.07, top + (bot-top)*0.12, 12.5, CHROME))
    add(rod("collar2", top + (bot-top)*0.83, top + (bot-top)*0.88, 12.5, CHROME))
    w = WHEEL.copy(); w.data = WHEEL.data; link(w)
    w.location = Vector(Lc(AX, 0, ZA)) * S
    w.rotation_euler = (0, 0, 0 if sx > 0 else math.pi)
    add(w)
    return e

corner(-1, 1, STEER_L, True)
corner(1, 1, STEER_R, True)
corner(-1, -1, 0, False)
corner(1, -1, 0, False)
WHEEL.hide_render = True; WHEEL.hide_viewport = True

# tie rod: 5/16 rod with a heim joint at each end, sitting on top of the two arms
zt = ZP + 6.35 + 9
a, b = tipL(STEER_L) + Vector((0, 0, zt)), tipR(STEER_R) + Vector((0, 0, zt))
for p in (a, b):
    cyl("heim_eye", p.x, p.y, p.z, 9, 9, BOLT, verts=24)
dirn = (b - a).normalized()
rod("heim_shank", a + dirn*8, a + dirn*30, 4.5, BOLT)
rod("heim_shank", b - dirn*8, b - dirn*30, 4.5, BOLT)
rod("tie_rod", a + dirn*30, b - dirn*30, 4.0, CHROME)
label("tierod", (a.x+b.x)/2, (a.y+b.y)/2, zt)

# actuator: back pin on a 2 in angle under the middle cross rail, rod pushes the right plate from underneath
hR = PR + rotz(ACTH, STEER_R) + Vector((0, 0, ZP - 14))
pin = ACT_PIN.copy(); pin.z = hR.z
d = (hR - pin); Ld = d.length; dn = d.normalized()
BODY = 175
rod("act_motor", pin + dn*18, pin + dn*(18+BODY), 15, ACT, 32)
box_m = rod("act_gearbox", pin + dn*8, pin + dn*60, 21, ACT, 32)
rod("act_rod", pin + dn*(18+BODY), hR - dn*10, 5, CHROME)
cyl("act_clevis", hR.x, hR.y, hR.z, 8, 12, BOLT, verts=20)
cyl("act_pinbolt", pin.x, pin.y, pin.z, 6, 30, BOLT, verts=20)
label("actuator", *(pin + dn*90))
# 2 in angle bolted under the cross rail, one leg hanging down
ay = pin.y
box("angle_flat", pin.x, ay, -1.6, 50.8, 50.8, 3.2, ALU)
box("angle_leg", pin.x, ay - 25.4 + 1.6, -1.6 - 25.4, 50.8, 3.2, 50.8, ALU)
box("angle_leg2", pin.x, ay + 22, pin.z + 10, 50.8, 3.2, 40, ALU)
label("angle", pin.x - 10, ay - 26, -30)

label("plateL", -XR - 20, YAX + 30, ZP + 3)
label("plateR", XR - 30, YAX + 25, ZP + 5)
label("shock", -(XR + 25), YAX, ZP - 60)
label("arm", -(XR + 30), YAX - 24, ZP - 120)
label("wheel", -(XR + WOFF + 40), YAX, ZP - AXLE_DZ)
label("blackplate", -(XR - 10), YAX + 50, ZP - 3)

label("nutR", XR, YAX, ZP + 12)
label("blackR", XR + 5, YAX + 50, ZP - 5)
label("shockR", XR + 18, YAX, ZP - 60)
label("armR", XR + 16, YAX + 24, ZP - 104)
label("actend", *(hR - dn*35))
label("tierodR", *(b - dirn*60))
label("tallbox", -XR, -YE, 260)
label("blacktop", -XR, -150, ZT + 10)
box("ground", 0, 0, GROUND_Z - 1, 4000, 4000, 2, GROUND)

# ================= LIGHT + CAMERA (same as v2) =================
wd = bpy.data.worlds.new("w"); sc.world = wd; wd.use_nodes = True
wd.node_tree.nodes["Background"].inputs[0].default_value = (0.95, 0.96, 0.98, 1)
wd.node_tree.nodes["Background"].inputs[1].default_value = 0.28
bpy.ops.object.light_add(type="AREA", location=(-0.9, 0.7, 1.4)); Lt = bpy.context.object
Lt.data.energy = 70; Lt.data.size = 1.4; Lt.rotation_euler = (math.radians(35), 0, math.radians(-130))
bpy.ops.object.light_add(type="SUN"); L2 = bpy.context.object
L2.data.energy = 1.6; L2.rotation_euler = (math.radians(40), math.radians(-20), math.radians(-40))
bpy.ops.object.camera_add(); cam = bpy.context.object; sc.camera = cam
def look(loc, target):
    cam.location = Vector(loc); d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
res = (1600, 1200)
if VIEW == "iso":     # matched to Matt's 3/4 photo: low front on the left, tall back on the right
    look((-0.95, 0.18, 0.52), (0.0, 0.0, 0.03)); cam.data.lens = 30
elif VIEW == "top":
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 0.78; cam.location = (0, 0.0, 2); cam.rotation_euler = (0, 0, 0); res = (1300, 1400)
elif VIEW == "side":
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 1.0; look((-2.0, 0, 0.045), (0, 0, 0.045)); res = (1500, 1000)
elif VIEW == "corner":  # right front corner from in front, low, a little inboard
    look((-0.01, 0.56, -0.05), (0.12, 0.19, -0.04)); cam.data.lens = 34; res = (1600, 1200)
sc.render.engine = "CYCLES"; sc.cycles.samples = 24
try:
    pr = bpy.context.preferences.addons["cycles"].preferences
    pr.compute_device_type = "METAL"; pr.get_devices()
    for d_ in pr.devices: d_.use = True
    sc.cycles.device = "GPU"
except Exception as ex: print("gpu fail", ex)
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = res
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"
sc.render.filepath = f"{OUT}/{VIEW}.png"
bpy.context.view_layer.update()
co = {}
for k, (x, y, z) in LABELS.items():
    v = world_to_camera_view(sc, cam, Vector((x*S, y*S, z*S))); co[k] = (v.x, 1 - v.y)
json.dump(co, open(f"{OUT}/{VIEW}.json", "w"))
bpy.ops.render.render(write_still=True)
