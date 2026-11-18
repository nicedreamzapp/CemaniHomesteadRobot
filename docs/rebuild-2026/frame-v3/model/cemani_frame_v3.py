# Cemani frame v3: the rebuilt frame (11/10) from Matt's photos, with the front steering v3 laid out (updated 2026-11-18).
# Front steering = steering-v3 "Fix A" corner (steering-v3-view/corner-cart.html): UCF204-12 flange bearing under two 2020 rails,
# 3/4 x 2 in clevis pin as the kingpin, Ruland clamp collar under a 1/4 in steering plate, black plate on 15 mm standoffs,
# Glideforce LACT4P actuator from a bracket on a 2020 stub under the LEFT side rail to the RIGHT plate, 5/16-24 tie rod with CF5 heims.
# Back corners unchanged (black plate straight under the rail) until the identical rear axle is built.
# Run: Blender -b --factory-startup -P cemani_frame_v3.py -- VIEW      VIEW = iso | side | top | corner
# Then: python3 callouts.py   (labels the renders and writes ../iso.jpg side.jpg top.jpg corner.jpg)
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
BEARING = mat("ucf", (0.42, 0.44, 0.47), 0.25, 0.6)     # UCF204 housing: gray painted cast iron
STEEL = mat("steel", (0.78, 0.79, 0.81), 1.0, 0.28)      # 3/4 in clevis pin + Ruland collar
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
YACT = 32              # bottom cross rail in the middle of the low box (no longer carries the actuator)

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
for y in (-YIN, YACT):   # no front inner cross rail: the steering corners' inboard 2020 rails + bearings sit there now
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
label("inner", 60, -YIN, ZB+10)

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
for y in (-YIN, YACT):
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

# ================= STEERING GEOMETRY (steering-v3 Fix A, sizes from steering-v3-view/steps-4ws.js DIMS) =================
# Each front corner, top to bottom: 2 x 2020 rails (side rail + a 110.9 mm inboard rail, 64 mm apart) -> UCF204-12 flange bearing
# (86 sq, 4 bolts on a 64 mm square: M5 x 18 + 12 x 5.2 sleeves into T-nuts) -> 3/4 x 2 in clevis pin (kingpin, head on top of the
# inner ring) -> 1/4 in steering plate under the inner ring -> Ruland FHT-MCL-12E-F collar under the plate (2 x M6 x 16 flat heads)
# -> 4 x 15 mm standoffs -> the existing black plate (M5 x 40, fender washer + nylock on top) -> shock, arms, hub motor wheel.
PIV = 32.0              # pivot sits 32 mm inboard of the side rail centre, midway to the inboard rail
YAX = 228.6             # half of the 18 in wheelbase
AXLE_DZ = 120.5         # black plate top to axle (floor to frame was 8 3/4 in with the black plate right under the rail)
WOFF = 222.25 - XR      # wheel centre this far outside the side rail (17 1/2 in centre to centre), same front and back
INL = 70.0              # inboard rail starts 70 mm behind the pivot (110.9 mm long, to the front end rail)
# z of each layer, 0 = underside of the bottom rails
EAR, BOSS, INS = 12.0, 14.0, 7.0          # UCF204: flange, boss, inner ring below the boss
PLATE_T, COL_W, STD, BLACK_T = 6.35, 15.0, 15.0, 6.0
Z_EAR = -EAR; Z_BOSS = Z_EAR - BOSS; Z_INS = Z_BOSS - INS       # -12, -26, -33
Z_PLATE = Z_INS - PLATE_T                                        # steering plate bottom, -39.35
Z_COL = Z_PLATE - COL_W                                          # collar bottom = standoff bottom = black plate top, -54.35
FRONT_BT = Z_COL                                                 # front black plate top
BACK_BT = 0.0                                                    # back black plate top (bolted straight under the rail)
PIN_L, PIN_HR, PIN_HT, SHAFT_R = 50.8, 14.3, 6.35, 9.525
# steering plate outline (u = outward, v = toward the frame end) = steering-v3-view/plates/steer-plate-*-fixA.dxf, 98 x 167 mm
OUTL = [(-42, -95), (14, -95), (56, -70), (56, 50), (30, 72), (-3, 72), (-12, 50), (-42, 50)]
ARM = (12.5, 57.3)      # tie rod hole: 12.5 out, 57.3 ahead of the pin (both plates)
ACTH = (48.0, -63.0)    # actuator hole, right plate only (moved 11/18 so it never goes over dead center, PHYSICS.md)
SLOTS = [(-9, -32.75), (-9, 32.75), (32, -32.75), (32, 32.75)]   # black plate screw slots (8 x 13 mm) / standoffs
BPU = 11.5              # black plate centre, outward of the pivot (20.5 mm inboard of the side rail, same as the back)
HEIM_SPC, HEIM_T, HEIM_OD, HEIM_L = 8.0, 11.1, 22.23, 34.93
# actuator: Glideforce LACT4P-12V-10, 246-346 mm hole to hole; back pin on bracket 2314 under a 110 mm 2020 stub under the left side rail
ACT_RET, ACT_EXT = 246.0, 346.0
STUB_L, STUB_Y = 110.0, -30.0           # stub ~10 1/4 in behind the front wheel centres
BRK_PIN_H = 29.2
ACT_PIN = Vector((-65.5, STUB_Y, -20.0 - BRK_PIN_H))
PL, PR = Vector((-(XR - PIV), YAX, 0)), Vector((XR - PIV, YAX, 0))

def rotz(v, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    return Vector((c*v[0] - s*v[1], s*v[0] + c*v[1], 0))
def tipL(a): return PL + rotz((-ARM[0], ARM[1]), a)     # left plate: outward is -x
def tipR(a): return PR + rotz((ARM[0], ARM[1]), a)
TIE = (tipL(0) - tipR(0)).length                       # heim eye to eye (about 246 mm with the 200 mm rod)
def right_for(aL):   # right plate angle that keeps the tie rod length
    f = lambda aR: abs((tipL(aL) - tipR(aR)).length - TIE)
    return min((aL + k*0.01 for k in range(-2000, 2001)), key=f)
def left_for(aR):
    f = lambda aL: abs((tipL(aL) - tipR(aR)).length - TIE)
    return min((aR + k*0.01 for k in range(-2000, 2001)), key=f)
Z_ACTEND = Z_PLATE - 6
def act_len(aR): return ((PR + rotz(ACTH, aR) + Vector((0, 0, Z_ACTEND))) - ACT_PIN).length

MAXT = 30.0   # inside wheel at full lock
stats = {"tie_rod_eye_to_eye_mm": TIE,
         "left_turn": {"left_inner_deg": MAXT, "right_outer_deg": right_for(MAXT)},
         "right_turn": {"right_inner_deg": -MAXT, "left_outer_deg": left_for(-MAXT)}}
lens = {"left_turn": act_len(right_for(MAXT)), "straight": act_len(0.0), "right_turn": act_len(-MAXT)}
stats["actuator_len_mm"] = lens
stats["actuator_range_mm"] = [ACT_RET, ACT_EXT]
stats["actuator_spare_mm"] = {"closed": min(lens.values()) - ACT_RET, "open": ACT_EXT - max(lens.values())}
stats["stroke_used_mm"] = max(lens.values()) - min(lens.values())
stats["front_stack_mm"] = -FRONT_BT
json.dump(stats, open(f"{OUT}/steer_stats.json", "w"), indent=1)
print("STEER STATS", json.dumps(stats))

STEER_L = 20.0 if VIEW != "side" else 0.0
STEER_R = right_for(STEER_L)

# ================= FIXED FRONT PARTS (frame side) =================
def front_fixed(sx):
    px, py = sx*(XR - PIV), YAX
    xin = sx*(XR - 2*PIV)
    y0 = YAX - INL; yend = YE - 3
    extr("inboard_rail", yend - y0, "y", xin, (y0 + yend)/2, ZB)            # 110.9 mm
    extr("cross_piece", 2*PIV - 20, "x", px, y0 + 10, ZB)                   # 44 mm
    box("Lbrk", xin, YE - 4.5, ZB, 20, 3, 20, ALU)
    box("Lbrk", sx*(XR - 11.5), y0 + 10, ZB, 3, 20, 20, ALU)
    box("Lbrk", sx*(XR - 2*PIV + 11.5), y0 + 10, ZB, 3, 20, 20, ALU)
    # UCF204-12: gray cast flange (86 sq), boss, chrome inner ring
    box("ucf_flange", px, py, Z_EAR/2, 86, 86, EAR, BEARING, bevel=3)
    cyl("ucf_boss", px, py, Z_EAR - BOSS/2, 28, BOSS, BEARING, verts=48)
    for dx in (-32, 32):
        for dy in (-32, 32):
            cyl("m5x18_washer", px+dx, py+dy, Z_EAR - 0.6, 5, 1.2, BOLT, verts=16)
            cyl("m5x18_head", px+dx, py+dy, Z_EAR - 1.2 - 2.5, 4.25, 5, BOLT, verts=6)
    label("bearing" + ("R" if sx > 0 else "L"), px + sx*30, py - 30, Z_EAR)
    label("inrail" + ("R" if sx > 0 else "L"), xin, y0 + 30, 0)

# ================= CORNERS =================
def corner(sx, sy, steer, front):
    """front: the steering corner (pivot 32 mm inboard). back: black plate straight under the rail, as on the robot today."""
    us = PIV if front else 0.0                 # suspension keeps its place under the side rail
    px, py = sx*(XR - us), sy*YAX
    BT = FRONT_BT if front else BACK_BT
    e = bpy.data.objects.new("steer", None); link(e)
    e.location = (px*S, py*S, BT*S); e.rotation_euler = (0, 0, math.radians(steer))
    parts = []
    def add(o): o.parent = e; parts.append(o); return o
    def Lc(u, v, z): return (sx*u, sy*v, z)                    # u outward, v toward the frame end, z from black plate top
    def Ls(u, v, z): return (sx*(u + us), sy*v, z)             # suspension, u measured from the side rail
    def Zg(z): return z - BT                                     # global z (0 = rail underside) -> local
    if front:
        side = "R" if sx > 0 else "L"
        add(cyl("inner_ring", 0, 0, Zg(Z_INS/2), 14.5, -Z_INS, CHROME, verts=40))
        add(cyl("pin_head", 0, 0, Zg(PIN_HT/2), PIN_HR, PIN_HT, STEEL, verts=40))
        add(cyl("pin", 0, 0, Zg(-PIN_L/2), SHAFT_R, PIN_L, STEEL, verts=32))
        pts = [(sx*u, sy*v) for u, v in OUTL]
        add(slab("steer_plate", pts, (0, 0, Zg(Z_PLATE + PLATE_T/2)), (1, 0, 0), (0, 1, 0), PLATE_T, NEWALU, 0.6))
        for u in (-14.73, 14.73):   # M6 x 16 flat heads, flush in the countersinks, down into the collar
            add(cyl("m6_flat", *Lc(u, 0, Zg(Z_INS - 0.2)), 5.5, 0.6, BOLT, verts=20))
        add(cyl("collar", 0, 0, Zg(Z_COL + COL_W/2), 20, COL_W, STEEL, verts=48))
        add(box("collar_screw", *Lc(0, -18, Zg(Z_COL + COL_W/2)), 12, 6, 7, BOLT))
        for u, v in SLOTS:
            add(cyl("standoff", *Lc(u, v, Zg(Z_COL + STD/2)), 5, STD, CHROME, verts=20))
            add(cyl("fender_washer", *Lc(u, v, Zg(Z_INS + 0.6)), 10, 1.2, BOLT, verts=24))
            add(cyl("nylock", *Lc(u, v, Zg(Z_INS + 1.2 + 2.5)), 4.6, 5, BOLT, verts=6))
            add(cyl("m5x40_head", *Lc(u, v, -BLACK_T - 2.5), 4.25, 5, BOLT, verts=6))
        # heim joint on an 8 mm spacer on top of the arm hole, 5/16 bolt down, nylock under the plate
        add(cyl("heim_spacer", *Lc(*ARM, Zg(Z_INS + HEIM_SPC/2)), 8, HEIM_SPC, CHROME, verts=20))
        add(cyl("heim_bolt_head", *Lc(*ARM, Zg(Z_INS + HEIM_SPC + HEIM_T + 2.5)), 7, 5, BOLT, verts=6))
        add(cyl("heim_nylock", *Lc(*ARM, Zg(Z_PLATE - 3.5)), 7, 7, BOLT, verts=6))
        if sx > 0:   # actuator rod end under the right plate: 1/4-20 x 1-1/2 bolt down, nylock under the rod end
            add(cyl("act_bolt_head", *Lc(*ACTH, Zg(Z_INS + 2)), 6, 4, BOLT, verts=6))
            add(cyl("act_nylock", *Lc(*ACTH, Zg(Z_ACTEND - 9)), 6, 6, BOLT, verts=6))
        add(box("blackplate", *Lc(BPU, 0, -BLACK_T/2), 56, 100, BLACK_T, BLKANO, bevel=1.5))
        label("pin" + side, px, py, PIN_HT)
        label("plate" + side, px + sx*50, py, Z_PLATE + 3)
        label("collar" + side, px - sx*20, py, Z_COL + 7)
        label("standoff" + side, px + sx*32, py - 32.75, Z_COL + 7)
    else:
        add(box("blackplate", *Lc(-12, 0, -3), 56, 100, 6, BLKANO, bevel=1.5))
        for bu, bv in ((-30, -38), (-30, 38), (6, -38), (6, 38)):
            add(cyl("screw", *Lc(bu, bv, 1.5), 4.5, 3, BOLT, verts=16))
    # two side plates hanging down (front and back), shock between them
    up = [(-30, -6), (8, -6), (6, -150), (-20, -150)]
    for v in (-18, 18):
        add(slab("upright", [(sx*(u + us), z) for u, z in up], (0, sy*v, 0), (1, 0, 0), (0, 0, 1), 5, BLKANO))
    # twin swing arms out to the axle block
    AX = WOFF; ZA = -AXLE_DZ
    for (u0, z0), (u1, z1) in (((-8, -100), (40, -108)), ((-8, -142), (40, -134))):
        for v in (-24, 24):
            a0, a1 = Vector((u0, z0)), Vector((u1, z1)); d = (a1-a0); n = Vector((-d.y, d.x)).normalized()*9
            ex = d.normalized()*9
            q = [a0-ex+n, a1+ex+n, a1+ex-n, a0-ex-n]
            add(slab("arm", [(sx*(p.x + us), p.y) for p in q], (0, sy*v, 0), (1, 0, 0), (0, 0, 1), 5, BLKANO))
        add(rod("arm_pin", Ls(u0, -30, z0), Ls(u0, 30, z0), 4, BOLT))
        add(rod("arm_pin", Ls(u1, -30, z1), Ls(u1, 30, z1), 4, BOLT))
    add(box("axle_block", *Ls(40, 0, ZA), 18, 40, 52, BLKANO, bevel=2))
    # coil-over: top at the side plates, bottom on the upper arm near the wheel
    top = Vector(Ls(4, 0, -16)); bot = Vector(Ls(34, 0, -104))
    add(rod("shock_body", top, top + (bot-top)*0.62, 7.5, CHROME))
    add(rod("shock_shaft", top + (bot-top)*0.55, bot, 3.5, CHROME))
    add(helix("spring", top + (bot-top)*0.1, top + (bot-top)*0.85, 11.5, 7, CHROME, 1.7))
    add(rod("collar", top + (bot-top)*0.07, top + (bot-top)*0.12, 12.5, CHROME))
    add(rod("collar2", top + (bot-top)*0.83, top + (bot-top)*0.88, 12.5, CHROME))
    w = WHEEL.copy(); w.data = WHEEL.data; link(w)
    w.location = Vector(Ls(AX, 0, ZA)) * S
    w.rotation_euler = (0, 0, 0 if sx > 0 else math.pi)
    add(w)
    return e

for s_ in (-1, 1): front_fixed(s_)
corner(-1, 1, STEER_L, True)
corner(1, 1, STEER_R, True)
corner(-1, -1, 0, False)
corner(1, -1, 0, False)
WHEEL.hide_render = True; WHEEL.hide_viewport = True

# tie rod: 200 mm 5/16-24 rod with a CF5 heim joint at each end, heims on 8 mm spacers on top of the two arm holes
zt = Z_INS + HEIM_SPC + HEIM_T/2
a, b = tipL(STEER_L) + Vector((0, 0, zt)), tipR(STEER_R) + Vector((0, 0, zt))
for p in (a, b):
    cyl("heim_eye", p.x, p.y, p.z, HEIM_OD/2, HEIM_T, CHROME, verts=24)
dirn = (b - a).normalized()
rod("heim_shank", a + dirn*(HEIM_OD/2 - 1), a + dirn*HEIM_L, 6.35, CHROME)
rod("heim_shank", b - dirn*(HEIM_OD/2 - 1), b - dirn*HEIM_L, 6.35, CHROME)
rod("tie_rod", a + dirn*(HEIM_L - 6), b - dirn*(HEIM_L - 6), 3.97, CHROME)
label("tierod", (a.x+b.x)/2, (a.y+b.y)/2, zt)

# actuator stub: 110 mm 2020 across under the LEFT side rail, joined with an L bracket; bracket 2314 under it (2 x M5 x 12 + T-nuts)
stub_x = -XR + STUB_L/2 - 10
extr("act_stub", STUB_L, "x", stub_x, STUB_Y, -10)
box("Lbrk_stub", -XR + 11.5, STUB_Y, 10, 3, 20, 20, ALU)
box("Lbrk_stub", -XR + 22, STUB_Y, 1.5, 20, 20, 3, ALU)
pin = ACT_PIN.copy()
box("brk_base", pin.x, pin.y, -21.5, 38, 39.6, 3, ALU)
for ey in (-12, 12):
    box("brk_ear", pin.x, pin.y + ey, -23 - (BRK_PIN_H + 3)/2, 38, 7.7, BRK_PIN_H + 3, ALU)
for dx in (-10.15, 10.15):
    cyl("brk_screw", pin.x + dx, pin.y, -23 - 1.5, 4.25, 3, BOLT, verts=6)
# Glideforce LACT4P: motor/gear end at the back pin, tube, chrome rod out to the right plate (rides along as the plate turns)
hR = PR + rotz(ACTH, STEER_R) + Vector((0, 0, Z_ACTEND))
d = (hR - pin); Ld = d.length; dn = d.normalized()
rod("act_motor", pin + dn*12, pin + dn*110, 20, ACT, 32)
rod("act_tube", pin + dn*110, pin + dn*(ACT_RET - 9), 15.25, ACT, 32)
rod("act_rod", pin + dn*(ACT_RET - 14), hR - dn*6, 6, CHROME)
cyl("act_rodend", hR.x, hR.y, hR.z, 8, 12, CHROME, verts=20)
cyl("act_pin", pin.x, pin.y, pin.z, 3.2, 40.4, CHROME, verts=16)
stats["actuator_len_now_mm"] = Ld
label("actuator", *(pin + dn*90))
label("stub", -XR + 30, STUB_Y, -10)
label("actend", *(hR - dn*20))
label("tierodR", *(b - dirn*60))

label("shock", -(XR + 25), YAX, FRONT_BT - 60)
label("arm", -(XR + 30), YAX - 24, FRONT_BT - 120)
label("wheel", -(XR + WOFF + 40), YAX, FRONT_BT - AXLE_DZ)
label("blackplate", -(XR - 10), YAX + 50, FRONT_BT - 3)
label("blackR", XR - 5, YAX + 50, FRONT_BT - 5)
label("shockR", XR + 18, YAX, FRONT_BT - 60)
label("armR", XR + 16, YAX + 24, FRONT_BT - 104)
label("tallbox", -XR, -YE, 260)
label("blacktop", -XR, -150, ZT + 10)

# Front-only for now: the front corners sit 54 mm lower under the frame than the back ones, so the robot noses up until the
# identical rear axle goes in. Tilt everything about the back tire contact so all 4 tires sit on the ground.
GROUND_Z = BACK_BT - AXLE_DZ - WR
PITCH = math.atan2(BACK_BT - FRONT_BT, 2*YAX)
stats["pitch_deg_front_only"] = math.degrees(PITCH)
json.dump(stats, open(f"{OUT}/steer_stats.json", "w"), indent=1)
from mathutils import Matrix
PV = Vector((0, -YAX, GROUND_Z))
TILT_MM = Matrix.Translation(PV) @ Matrix.Rotation(PITCH, 4, "X") @ Matrix.Translation(-PV)
robot = bpy.data.objects.new("robot", None); link(robot)
for o in list(sc.objects):
    if o is not robot and o.parent is None:
        o.parent = robot
robot.matrix_world = Matrix.Translation(PV*S) @ Matrix.Rotation(PITCH, 4, "X") @ Matrix.Translation(-PV*S)
for k, v in list(LABELS.items()):
    LABELS[k] = tuple(TILT_MM @ Vector(v))
box("ground", 0, 0, GROUND_Z - 1, 4000, 4000, 2, GROUND)

# ================= LIGHT + CAMERA (same as v2; corner camera raised for the front-only nose-up) =================
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
    look((0.0, 0.5, -0.02), (0.12, 0.2, -0.015)); cam.data.lens = 34; res = (1600, 1200)
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
