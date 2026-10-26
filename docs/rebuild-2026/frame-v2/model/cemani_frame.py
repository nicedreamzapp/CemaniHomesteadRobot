# Cemani frame v2: stiffer frame, real-looking corners (black plate, side plates, swing arm, coil-over, hub motor)
# Run: Blender -b --factory-startup -P frame2.py -- VIEW [notop]   VIEW = iso | top | side | corner
import bpy, bmesh, math, json, sys
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

S = 0.001
OUT = "render"
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
VIEW = argv[0] if argv else "iso"
TOPDECK = not (len(argv) > 1 and argv[1] in ("notop", "bare"))
BARE = len(argv) > 1 and argv[1] == "bare"

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
LABELS = {}
def label(k, x, y, z): LABELS[k] = (x, y, z)

def mat(name, rgb, metal=0.0, rough=0.5, alpha=1.0, emit=None):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try: m.surface_render_method = "BLENDED"
        except Exception: pass
    return m

BLUE = mat("blue400", (0.13, 0.32, 0.72), 0.7, 0.35)
ORANGE = mat("orange150", (0.95, 0.42, 0.06), 0.7, 0.35)
GREEN = mat("green250", (0.12, 0.6, 0.25), 0.7, 0.35)
PURPLE = mat("cross400", (0.45, 0.2, 0.7), 0.7, 0.35)
ALU = mat("alu", (0.78, 0.79, 0.81), 0.9, 0.32)
CLEAR = mat("clear", (0.75, 0.85, 0.95), 0.0, 0.05, 0.2)
BLKANO = mat("blackano", (0.025, 0.025, 0.028), 0.6, 0.35)
TIRE = mat("tire", (0.09, 0.09, 0.09), 0.0, 0.8)
CHROME = mat("chrome", (0.92, 0.92, 0.94), 1.0, 0.08)
HUBSILVER = mat("hub", (0.82, 0.83, 0.85), 0.8, 0.3)
WHITE = mat("white", (0.92, 0.93, 0.95), 0.0, 0.4)
LBLUE = mat("lblue", (0.1, 0.35, 0.8), 0.0, 0.4)
BATT = mat("batt", (0.07, 0.07, 0.08), 0.1, 0.55)
DRV = mat("drv", (0.85, 0.3, 0.12), 0.4, 0.45)
BOARD = mat("board", (0.05, 0.35, 0.15), 0.1, 0.5)
RED = mat("red", (0.8, 0.05, 0.05), 0.2, 0.4)
BOLT = mat("bolt", (0.6, 0.6, 0.62), 1.0, 0.25)
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

def boolean(o, cutter):
    bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("bool", "BOOLEAN"); md.operation = "DIFFERENCE"; md.object = cutter
    md.solver = "EXACT"
    bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def join(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    return bpy.context.object

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
def extr(name, length, axis, cx, cy, cz, m):
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

def tri_gusset(name, origin, u, v, size, m, thick=3):
    """flat triangle plate: right angle at origin, legs along unit vectors u and v (world mm)"""
    o0 = Vector(origin); u = Vector(u); v = Vector(v); nrm = u.cross(v).normalized()
    pts = [o0, o0 + u*size, o0 + v*size]
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new(p*S) for p in pts] + [bm.verts.new((p + nrm*thick)*S) for p in pts]
    bm.faces.new(vs[:3]); bm.faces.new(vs[3:][::-1])
    for i in range(3):
        j = (i+1) % 3; bm.faces.new([vs[i], vs[j], vs[3+j], vs[3+i]])
    bm.normal_update(); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); link(o); me.materials.append(m)
    # bolt heads
    for a, b in ((0.18, 0.18), (0.55, 0.18), (0.18, 0.55)):
        p = o0 + u*size*a + v*size*b + nrm*(thick+1)
        c = cyl("bolthead", p.x, p.y, p.z, 4.2, 2.5, BOLT, verts=16)
        c.rotation_euler = nrm.to_track_quat("Z", "Y").to_euler()
    return o

# ================= FRAME =================
# z=0 is the underside of the bottom rails.  Front is +y.
XR, HL = 190, 285
for z in (10, 280):
    extr("end_front", 400, "x", 0, HL, z, BLUE)
    extr("end_back", 400, "x", 0, -HL, z, BLUE)
    for s in (-1, 1):
        extr("side150", 150, "y", s*XR, 200, z, ORANGE)
        extr("side400", 400, "y", s*XR, -75, z, BLUE)
UPS = (285, 125, -125, -285)
for s in (-1, 1):
    for y in UPS:
        extr("up250", 250, "z", s*XR, y, 145, GREEN)
# cross members under the bottom rails, right under the wheel mounts
YC = 125
for sy in (1, -1):
    extr("cross400", 400, "x", 0, sy*YC, -10, PURPLE)
label("l400", -XR-10, -200, 290); label("l150", -XR-10, 200, 290); label("l250", -XR-10, -125, 200)
label("cross", -120, -YC, -20); label("joint", -XR-11, 125, 10)
label("gusset", -XR-12, -125-30, 45); label("jointplate", -XR-12, 125, 280); label("crossF", 60, YC, -20)

# joint plates: outside face and bottom face of each 150/400 joint, top and bottom layers
for s in (-1, 1):
    for z in (10, 280):
        box("joinplate", s*(XR+11.5), 125, z, 3, 90, 20, ALU)
    box("joinplate_top", s*XR, 125, 281.5+10, 20, 90, 3, ALU)  # top face of the top layer joint
# triangle gussets on the outside face at every upright, top and bottom
for s in (-1, 1):
    xo = s*(XR+10)
    for y in UPS:
        for z, vz in ((20, 1), (270, -1)):
            dirs = []
            if y < HL: dirs.append(1)
            if y > -HL: dirs.append(-1)
            for dy in dirs:
                tri_gusset("gusset", (xo, y + dy*10, z), (0, dy, 0), (0, 0, vz), 70, ALU)
# gussets on the front and back faces at the corners
for sy in (1, -1):
    yo = sy*(HL+10)
    for s in (-1, 1):
        for z, vz in ((20, 1), (270, -1)):
            tri_gusset("gusset", (s*(XR-10), yo, z), (-s, 0, 0), (0, 0, vz), 70, ALU)
# corner brackets tying the cross members to the side rails (inside)
for sy in (1, -1):
    for s in (-1, 1):
        box("xbracket", s*(XR-22), sy*YC, -10, 3, 40, 18, ALU)

if not BARE:
    # ================= DECKS =================
    # lower deck: sits on top of the two cross members, between the side rails
    box("lower_deck", 0, 0, 2.4, 358, 270, 4.8, ALU)
    label("lowerdeck", -140, 100, 6)
    # batteries: 2 standing up, 76 thick each, side by side across the middle
    for x in (-38, 38):
        box("battery", x, 0, 4.8+82.5, 76, 180, 165, BATT, bevel=3)
        box("bterm+", x, 60, 4.8+165+5, 14, 14, 10, RED)
        box("bterm-", x, -60, 4.8+165+5, 14, 14, 10, BLKANO)
    for y in (-55, 55):
        box("strap", 0, y, 4.8+166, 158, 22, 2, BLKANO)
    label("batteries", 0, 0, 175)
    # drivers lying flat, one each side of the batteries
    for s in (-1, 1):
        box("driver", s*131, 0, 4.8+15.5, 97, 150, 31, DRV, bevel=2)
    label("drvL", -131, 0, 36); label("drvR", 131, 0, 36)
    # rear bay small plate: power switch + fuse
    box("rear_plate", 0, -205, 22.4, 358, 140, 4.8, ALU)
    box("estop", 120, -205, 40, 40, 40, 30, RED); label("estop", 120, -205, 55)
    box("fuse", -40, -205, 35, 60, 30, 20, BLKANO); label("fuse", -40, -205, 45)

    if TOPDECK:
        box("top_deck", 0, 0, 292.4, 400, 590, 4.8, CLEAR)
        box("jetson", -70, -110, 310, 100, 79, 30, BOARD); label("jetson", -70, -110, 325)
        box("teensy", 80, -60, 299, 61, 18, 8, BOARD); label("teensy", 80, -60, 304)
        box("esp32", 80, -120, 299, 52, 28, 8, BOARD); label("esp32", 80, -120, 304)
        box("dcdc12", -70, 10, 312, 80, 60, 35, BLKANO); label("dcdc", -70, 10, 330)
        box("bts", 80, 10, 300, 50, 50, 12, BOARD); label("bts", 80, 10, 306)
        cyl("lidar_base", 0, 200, 300, 48, 8, BLKANO)
        cyl("lidar", 0, 200, 325, 36, 42, BLKANO); label("lidar", 0, 200, 350)
        cyl("cam_f", -150, 255, 320, 30, 40, WHITE); label("camF", -150, 255, 345)
        cyl("cam_b", 150, -255, 320, 30, 40, WHITE); label("camB", 150, -255, 345)
    for x in (-110, 110):
        cyl("sonar", x, 298, 10, 9, 8, BLKANO, "y")
    label("sonar", 110, 300, 10)

    # ================= WHEEL (built once, copied) =================
    WR, WW = 101.5, 65
    def build_wheel():
        t = cyl("tire", 0, 0, 0, WR-4.5, WW, TIRE, "x", 96)
        bpy.ops.object.transform_apply(rotation=True)
        bv = t.modifiers.new("b", "BEVEL"); bv.width = 14*S; bv.segments = 5
        bpy.context.view_layer.objects.active = t; bpy.ops.object.modifier_apply(modifier="b")
        # tread: raised blocks around a slightly smaller core (two rows, staggered)
        lugs = []
        for i in range(44):
            a = 2*math.pi*i/44
            for xo in (-15, 15):
                g = box("lug", xo + (4 if i % 2 else -4), (WR-4)*math.cos(a), (WR-4)*math.sin(a), 27, 11.5, 2.6, TIRE)
                g.rotation_euler = (a, 0, 0); lugs.append(g)
        lj = join(lugs)
        # sidewall dimples: dark dots on the outer face, two rings
        HOLE = mat("hole", (0.01, 0.01, 0.01), 0.0, 1.0)
        holes = []
        for r, n in ((88, 36), (76, 30)):
            for i in range(n):
                a = 2*math.pi*(i + (0.5 if r == 76 else 0))/n
                holes.append(cyl("h", WW/2+0.6-(1.5 if r == 88 else 0), r*math.cos(a), r*math.sin(a), 3.4, 1, HOLE, "x", 12))
        hj = join(holes)
        parts = [t, lj, hj]
        # outer hub face: silver ring, white cap, blue band, text
        parts.append(cyl("hubring", WW/2-2, 0, 0, 66, 6, HUBSILVER, "x", 64))
        parts.append(cyl("hubcap", WW/2+1.5, 0, 0, 44, 2, WHITE, "x", 64))
        band = box("band", WW/2+2.7, 0, 0, 0.6, 80, 18, LBLUE)
        parts.append(band)
        bpy.ops.object.text_add(location=((WW/2+3.2)*S, 0, 0)); tx = bpy.context.object
        tx.data.body = "ZLTECH"; tx.data.size = 11*S; tx.data.align_x = "CENTER"; tx.data.align_y = "CENTER"
        tx.data.extrude = 0.3*S; tx.rotation_euler = (math.pi/2, 0, math.pi/2); tx.data.materials.append(WHITE)
        bpy.ops.object.convert(target="MESH"); parts.append(bpy.context.object)
        # inner face + axle stub
        parts.append(cyl("hubin", -WW/2+2, 0, 0, 58, 6, HUBSILVER, "x", 64))
        parts.append(cyl("axle", -WW/2-18, 0, 0, 8, 36, BOLT, "x", 24))
        for p in parts:
            bpy.context.view_layer.objects.active = p; p.select_set(True)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        w = join(parts); w.name = "wheel"
        return w
    WHEEL = build_wheel()

    # ================= CORNER (black plate, side plates, swing arm, coil-over) =================
    def helix(name, p0, p1, r, turns, m, wire=1.6):
        p0, p1 = Vector(p0), Vector(p1)
        cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"
        sp = cu.splines.new("POLY"); n = int(turns*24)
        sp.points.add(n)
        L = (p1-p0).length
        for i in range(n+1):
            a = 2*math.pi*turns*i/n
            sp.points[i].co = (r*math.cos(a)*S, r*math.sin(a)*S, (L*i/n)*S, 1)
        cu.bevel_depth = wire*S; cu.bevel_resolution = 3
        o = bpy.data.objects.new(name, cu); link(o); o.data.materials.append(m)
        o.location = p0*S
        o.rotation_euler = (p1-p0).to_track_quat("Z", "Y").to_euler()
        return o

    def rod(name, p0, p1, r, m, verts=24):
        p0, p1 = Vector(p0), Vector(p1); d = p1-p0
        c = cyl(name, *((p0+p1)/2), r, d.length, m, verts=verts)
        c.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
        return c

    def side_plate(name, pts, x, thick, m):
        """black plate in the y-z plane (a polygon), at lateral position x"""
        me = bpy.data.meshes.new(name); bm = bmesh.new()
        a = [bm.verts.new(((x-thick/2)*S, y*S, z*S)) for y, z in pts]
        b = [bm.verts.new(((x+thick/2)*S, y*S, z*S)) for y, z in pts]
        bm.faces.new(a[::-1]); bm.faces.new(b)
        n = len(pts)
        for i in range(n):
            j = (i+1) % n; bm.faces.new([a[i], a[j], b[j], b[i]])
        bm.normal_update(); bm.to_mesh(me); bm.free()
        o = bpy.data.objects.new(name, me); link(o); me.materials.append(m)
        bv = o.modifiers.new("b", "BEVEL"); bv.width = 1.2*S; bv.segments = 2
        return o

    PIVX = 185          # steering pivot / black plate centre, lateral
    STACK = 38          # steering pivot stack (front) or spacer (rear) under the cross member
    ZP = -20 - STACK    # top of the black plate
    ARM_Y, AXLE_DZ = 78, 98
    WX = 282            # wheel centre lateral
    GROUND_Z = ZP - 6 - AXLE_DZ - WR + 6

    def corner(sx, sy, steer, front):
        px, py = sx*PIVX, sy*YC
        # pivot stack or spacer (fixed to the frame)
        if front:
            box("pivot_plate", px, py, -20-4, 110, 80, 8, ALU)
            cyl("eared_bearing", px, py, -20-8-11, 26, 22, ALU, verts=40)
            cyl("thrust", px, py, -20-8-22-2, 20, 4, BOLT, verts=40)
            cyl("pivot_bolt", px, py, -20-STACK/2, 6, STACK, BOLT, verts=24)
        else:
            box("spacer", px, py, -20-STACK/2, 90, 80, STACK, ALU)
        e = bpy.data.objects.new("steer", None); link(e)
        e.location = (px*S, py*S, ZP*S); e.rotation_euler = (0, 0, math.radians(steer))
        parts = []
        def add(o):
            o.parent = e; parts.append(o)
        # local coords: X = sx*x (outward), Y = sy*y (toward the frame end), z down from plate top
        def L(x, y, z): return (sx*x, sy*y, z)
        # black top plate
        add(box("blackplate", *L(15, 0, -3), 100, 92, 6, BLKANO, bevel=1.5))
        for bx, by in ((-20, -32), (-20, 32), (50, -32), (50, 32)):
            add(cyl("screw", *L(bx, by, 1), 4.5, 3, BOLT, verts=16))
        # two side plates hanging down (gap holds the shock)
        up = [(-40, -6), (40, -6), (30, -78), (-30, -78)]
        for xo in (36, 66):
            o = side_plate("upright", [(sy*y, z) for y, z in up], sx*xo, 5, BLKANO)
            o.location = (0, 0, 0); add(o)
        # swing arm pair: pivots at bottom of side plates, reaches out to the axle
        pv = (0, -10, -68); ax = (0, ARM_Y, -6-AXLE_DZ)
        for xo in (36, 66):
            a0, a1 = Vector((sx*xo, sy*pv[1], pv[2])), Vector((sx*xo, sy*ax[1], ax[2]))
            d = a1 - a0; n = Vector((0, -d.z, d.y)).normalized() * 15
            ext = d.normalized()*14
            pts = [a0 - ext + n, a1 + ext + n, a1 + ext - n, a0 - ext - n]
            o = side_plate("arm", [(p.y, p.z) for p in pts], sx*xo, 5, BLKANO); add(o)
        add(rod("arm_pivot", L(28, pv[1], pv[2]), L(74, pv[1], pv[2]), 5, BOLT))
        add(rod("axle_clamp", L(28, ax[1], ax[2]), L(74, ax[1], ax[2]), 9, BLKANO))
        # coil-over between the side plates: top under the plate, bottom on the arm near the axle
        top = Vector(L(51, -18, -14)); bot = Vector(L(51, ARM_Y-22, -6-AXLE_DZ+10))
        add(rod("shock_body", top, top + (bot-top)*0.62, 7.5, CHROME))
        add(rod("shock_shaft", top + (bot-top)*0.55, bot, 3.5, CHROME))
        add(rod("shock_eye_t", L(40, -18, -14), L(62, -18, -14), 4, BOLT))
        add(rod("shock_eye_b", L(40, ARM_Y-22, -6-AXLE_DZ+10), L(62, ARM_Y-22, -6-AXLE_DZ+10), 4, BOLT))
        hp0 = top + (bot-top)*0.1; hp1 = top + (bot-top)*0.85
        add(helix("spring", hp0 + Vector((px, py, ZP)) - Vector((px, py, ZP)), hp1, 11.5, 7, CHROME, 1.7))
        add(rod("collar", top + (bot-top)*0.08, top + (bot-top)*0.12, 12.5, CHROME))
        add(rod("collar2", top + (bot-top)*0.83, top + (bot-top)*0.87, 12.5, CHROME))
        # the wheel (hub motor)
        w = WHEEL.copy(); w.data = WHEEL.data; link(w)
        w.location = Vector(L(WX-PIVX, ARM_Y, -6-AXLE_DZ)) * S
        w.rotation_euler = (0, 0, 0 if sx > 0 else math.pi)
        add(w)
        # local positions above are in mm for helpers that took mm; convert objects created in mm space
        for o in parts:
            if o is w: continue
            if o.type in ("MESH", "CURVE") and o.name.split(".")[0] in ("upright", "arm"):
                continue
        return e

    # helpers above create objects at mm*S world positions; parenting to e (no inverse) treats them as local.
    corner(-1, 1, 20, True)
    corner(1, 1, 14, True)
    corner(-1, -1, 0, False)
    corner(1, -1, 0, False)
    WHEEL.hide_render = True; WHEEL.hide_viewport = True
    label("pivot", -PIVX, YC, -30)
    label("shock", -PIVX - 51, YC + 10, ZP - 50)
    label("arm", -PIVX - 36, YC + 40, ZP - 85)
    label("wheel", -WX - 40, YC + ARM_Y, ZP - 6 - AXLE_DZ)
    label("spacer", PIVX, -YC, -40)

    # steering actuator and tie rod, just ahead of the front cross member
    box("actuator", -30, YC + 45, -32, 210, 26, 26, BLKANO, bevel=3); label("actuator", -30, YC + 45, -32)
    box("tierod", 0, YC + 60, -50, 330, 8, 8, ALU)


box("ground", 0, 0, (-60 if BARE else GROUND_Z) - 1, 4000, 4000, 2, GROUND)

# ================= LIGHT + CAMERA =================
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.95, 0.96, 0.98, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.35
bpy.ops.object.light_add(type="AREA", location=(0.6, 0.9, 1.4)); Lt = bpy.context.object
Lt.data.energy = 90; Lt.data.size = 1.2; Lt.rotation_euler = (math.radians(35), 0, math.radians(150))
bpy.ops.object.light_add(type="SUN"); L2 = bpy.context.object
L2.data.energy = 1.4; L2.rotation_euler = (math.radians(40), math.radians(-20), math.radians(-40))
bpy.ops.object.camera_add(); cam = bpy.context.object; sc.camera = cam
def look(loc, target):
    cam.location = Vector(loc); d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
res = (1600, 1200)
if VIEW == "iso":
    look((-1.05, 1.25, 0.85), (0, 0.0, -0.02)); cam.data.lens = 50
elif VIEW == "top":
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 0.8; cam.location = (0, 0, 2); cam.rotation_euler = (0, 0, 0); res = (1400, 1400)
elif VIEW == "side":
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 1.0; look((-2.0, 0, 0.05), (0, 0, 0.05)); res = (1400, 900)
elif VIEW == "isob":
    look((-0.82, 0.98, 0.62), (0, 0.0, 0.12)); cam.data.lens = 50
elif VIEW == "under":
    look((-0.75, 0.85, -0.6), (0, 0.0, 0.08)); cam.data.lens = 45
    bpy.data.objects["ground"].hide_render = True
elif VIEW == "corner":
    look((-0.02, 0.85, -0.06), (-0.24, 0.17, -0.15)); cam.data.lens = 50; res = (1400, 1100)
sc.render.engine = "CYCLES"; sc.cycles.samples = 128
try:
    pr = bpy.context.preferences.addons["cycles"].preferences
    pr.compute_device_type = "METAL"; pr.get_devices()
    for d in pr.devices: d.use = True
    sc.cycles.device = "GPU"
except Exception as ex: print("gpu fail", ex)
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = res
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"
name = f"{VIEW}{'_bare' if BARE else ('' if TOPDECK else '_notop')}"
sc.render.filepath = f"{OUT}/{name}.png"
bpy.context.view_layer.update()
co = {}
for k, (x, y, z) in LABELS.items():
    v = world_to_camera_view(sc, cam, Vector((x*S, y*S, z*S))); co[k] = (v.x, 1 - v.y)
json.dump(co, open(f"{OUT}/{name}.json", "w"))
bpy.ops.render.render(write_still=True)
