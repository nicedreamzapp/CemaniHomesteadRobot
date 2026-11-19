# Cemani, up-to-date plan: frame v3 sized to the real frame, 4-wheel steering (rear axle = the front axle mirrored, steering
# the opposite way for tight turns), and two reBot B601-DM arms, each on its own job: arm 1 on its plate on the front low box
# pulling a weed from a low garden bed in front, arm 2 on a plate across the back of the tall box top picking an apple up high.
# Run: Blender -b --factory-startup -P render_cemani_with_arm.py -- VIEW [j1 j2 j3 j4 j5 j6]   (VIEW = iso | side | front | top)
# Needs Seeed's URDF + colored visual STLs in $REBOT_DIR (default /tmp/rebot-dl): ReBot_Arm_DM.urdf, meshes/visual/*.stl
# (from github.com/Seeed-Projects/reBot-DevArm, Rebot_Arm_description/DM).
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
FRAME = os.path.join(HERE, "../../docs/rebuild-2026/frame-v3/model/cemani_frame_v3.py")
src = open(FRAME).read()
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
VIEW = argv[0] if argv else "iso"
POSE = [float(v) for v in argv[1:7]] if len(argv) >= 7 else [0.0, -2.913, -0.895, -0.752, 0.0, -3.14]

# Poses solved offline (damped least squares on Seeed's URDF chain): ARM1_TIP / ARM2_TIP are where each arm's fingertips land
# with the gripper pointing along ARM1_DIR / ARM2_DIR. FING1 / FING2 = how far each finger is opened (m) around the weed / apple.
ARM1_TIP, ARM1_DIR = (0.0, 520.0, -115.0), (0.0, 0.3, -0.95)
ARM2_BX, ARM2_BY = 85.0, -200.0
ARM2_POSE = [1.927, -1.339, -0.812, -1.033, -0.189, 3.068]
ARM2_TIP, ARM2_DIR = (-300.0, -380.0, 800.0), (-0.74, -0.48, 0.48)
FING1, FING2 = 0.004, 0.030

def sub(a, b):
    global src
    assert a in src, a
    src = src.replace(a, b, 1)

# real frame: front low box ~4 3/4 in long outside (11/11 tape photo) -> tall box front rail 100 mm behind the end rail
sub("YT = 135 ", "YT = 172.5 ")
# 4-wheel steering: same stack at the back, so the robot sits level; the rear inner cross rail makes room like the front one
sub("BACK_BT = 0.0 ", "BACK_BT = Z_COL ")
sub("for y in (-YIN, YACT):", "for y in (YACT,):")
sub("""for s_ in (-1, 1): front_fixed(s_)
corner(-1, 1, STEER_L, True)
corner(1, 1, STEER_R, True)
corner(-1, -1, 0, False)
corner(1, -1, 0, False)""", """_pre4ws = set(bpy.data.objects)
for s_ in (-1, 1): front_fixed(s_)
corner(-1, 1, STEER_L, True)
corner(1, 1, STEER_R, True)""")

EXTRA = '''
# ---- rear axle: copy every front steering part and mirror it front-to-back ----
_front = [o for o in bpy.data.objects if o not in _pre4ws and o is not WHEEL]
_mir = bpy.data.objects.new("rear_axle_mirror", None); link(_mir); _mir.scale = (1, -1, 1)
_map = {}
for o in _front:
    c = o.copy(); link(c); _map[o] = c
for o, c in _map.items():
    if o.parent in _map:
        c.parent = _map[o.parent]; c.matrix_parent_inverse = o.matrix_parent_inverse.copy()
    elif o.parent is None:
        c.parent = _mir
# ---- reBot arm plate + arm on the front low box ----
import urdf_arm
from mathutils import Matrix as _M, Vector as _V
PLATE_T = 6.35
PY = (YE + YT) / 2; PZ = ZM + 10
box("arm_plate", 0, PY, PZ + PLATE_T/2, 200, 130, PLATE_T, NEWALU)
_base = _M.Translation(_V((0, PY*S, (PZ + PLATE_T)*S))) @ _M.Rotation(math.radians(90), 4, "Z")
_J = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "finger_left", "finger_right"]
_rd = os.environ.get("REBOT_DIR", "/tmp/rebot-dl")
urdf_arm.build(os.path.join(_rd, "ReBot_Arm_DM.urdf"), os.path.join(_rd, "meshes"), _base,
               dict(zip(_J, %r + [%r, -%r])))
# ---- arm 2: second reBot on a plate across the two black top rails at the back of the tall box (plate TBD) ----
BX, BY = %r, %r
BZ = ZT + 10
box("arm2_plate", 0, BY, BZ + PLATE_T/2, W, 130, PLATE_T, NEWALU)
_base2 = _M.Translation(_V((BX*S, BY*S, (BZ + PLATE_T)*S))) @ _M.Rotation(math.radians(90), 4, "Z")
urdf_arm.build(os.path.join(_rd, "ReBot_Arm_DM.urdf"), os.path.join(_rd, "meshes"), _base2,
               dict(zip(_J, %r + [%r, -%r])))
ARM1_TIP, ARM1_DIR, ARM2_TIP, ARM2_DIR = %r, %r, %r, %r
APPLE_C = _V((-275.0, -365.0, 786.0))     # between arm 2's two finger pads (measured from the posed finger meshes)
import random as _r; _r.seed(7)
WOOD = mat("wood", (0.50, 0.34, 0.20), 0.0, 0.7)
SOIL = mat("soil", (0.16, 0.11, 0.07), 0.0, 0.95)
LEAF = mat("leaf", (0.16, 0.42, 0.10), 0.0, 0.55)
LEAF2 = mat("leaf2", (0.22, 0.50, 0.14), 0.0, 0.55)
BARK = mat("bark", (0.30, 0.20, 0.12), 0.0, 0.85)
APPLE = mat("apple", (0.62, 0.05, 0.04), 0.0, 0.35)
def leaf(c, d, L, w, m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1, location=_V(c)*S); o = bpy.context.object
    o.scale = (w*S, L*S, 1.2*S); o.rotation_euler = _V(d).normalized().to_track_quat("Y", "Z").to_euler()
    o.data.materials.append(m); o.name = "leaf"; return o
# ---- arm 1's own job: pulling a weed out of a low raised garden bed in front of the robot ----
GZ = BACK_BT - AXLE_DZ - WR
BED_Y0, BED_Y1, BED_X, BED_H = 400, 820, 260, 125
for sx_ in (-1, 1):
    box("bed_side", sx_*(BED_X - 12), (BED_Y0 + BED_Y1)/2, GZ + BED_H/2, 24, BED_Y1 - BED_Y0, BED_H, WOOD, 1.5)
for y_ in (BED_Y0 + 12, BED_Y1 - 12):
    box("bed_end", 0, y_, GZ + BED_H/2, 2*BED_X - 48, 24, BED_H, WOOD, 1.5)
SOIL_Z = GZ + BED_H - 12
box("bed_soil", 0, (BED_Y0 + BED_Y1)/2, (GZ + SOIL_Z)/2, 2*BED_X - 48, BED_Y1 - BED_Y0 - 48, SOIL_Z - GZ, SOIL)
def plant(x, y, h, n, m):
    rod("stem", (x, y, SOIL_Z), (x, y, SOIL_Z + h), 2.5, m, 8)
    for i in range(n):
        ang = i*2.4; zz = SOIL_Z + h*(0.35 + 0.65*i/max(n - 1, 1)); d = _V((math.cos(ang), math.sin(ang), 0.35))
        leaf(_V((x, y, zz)) + d*18, d, 22, 9, m)
for i, (x, y) in enumerate([(-170, 470), (-170, 600), (-170, 730), (170, 470), (170, 600), (170, 730)]):
    plant(x, y, 55 + 10*(i %% 2), 6, LEAF2)
T1 = _V(ARM1_TIP)
wz0 = SOIL_Z + 22                          # weed already pulled up ~22 mm, roots showing
rod("weed_stem", (T1.x, T1.y, wz0), (T1.x, T1.y, T1.z + 40), 3.0, LEAF, 10)   # flower stalk, gripped between the fingers
for k in range(7):                          # dandelion-style rosette hanging below the fingertips
    a_ = k*0.9; d = _V((math.cos(a_), math.sin(a_), -0.25)); leaf(_V((T1.x, T1.y, wz0 + 6)) + d*22, d, 26, 8, LEAF)
for k in range(7):
    a_ = k*0.9; rod("weed_root", (T1.x, T1.y, wz0), (T1.x + 14*math.cos(a_), T1.y + 14*math.sin(a_), SOIL_Z - 4), 0.9, BARK, 6)
bpy.ops.mesh.primitive_uv_sphere_add(radius=18*S, location=(T1.x*S, T1.y*S, (SOIL_Z + 1)*S)); _h = bpy.context.object
_h.scale = (1, 1, 0.25); _h.data.materials.append(SOIL); _h.name = "weed_hole_soil"
# ---- arm 2's own job: picking an apple off a branch up high, off the back left corner ----
T2, D2 = _V(ARM2_TIP), _V(ARM2_DIR).normalized()
ac = APPLE_C
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=34*S, location=ac*S); _a = bpy.context.object
_a.scale = (1, 1, 0.92); _a.data.materials.append(APPLE); _a.name = "apple"; bpy.ops.object.shade_smooth()
st = ac + _V((0, 0, 30))
rod("apple_stem", st, st + _V((0, 0, 30)), 1.6, BARK, 8)
br0, br1 = _V((-760, -640, 905)), _V((60, -330, 870))
rod("branch", br0, br1, 14, BARK, 16)
_bd = (br1 - br0).normalized(); _bp = br0 + _bd*(st + _V((0, 0, 28)) - br0).dot(_bd)
rod("twig", st + _V((0, 0, 28)), _bp, 4, BARK, 8)
for k in range(14):
    t = 0.08 + 0.065*k; c = br0.lerp(br1, t); d = _V((_r.uniform(-1, 1), _r.uniform(-1, 1), _r.uniform(-0.2, 0.6)))
    leaf(c + d.normalized()*30, d, 34, 14, LEAF2 if k %% 2 else LEAF)
_p2 = br0.lerp(br1, 0.3)
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=31*S, location=(_p2 + _V((0, 0, -62)))*S)
_b = bpy.context.object; _b.data.materials.append(APPLE); _b.name = "apple2"; bpy.ops.object.shade_smooth()
rod("apple2_stem", _p2 + _V((0, 0, -33)), _p2, 1.6, BARK, 8)
''' % (POSE, FING1, FING1, ARM2_BX, ARM2_BY, ARM2_POSE, FING2, FING2, ARM1_TIP, ARM1_DIR, ARM2_TIP, ARM2_DIR)
sub("# Front-only for now", EXTRA + "\n# Front-only for now")
sub('OUT = "/tmp/cemani/render3"', 'OUT = "/tmp/cemani/render_arm"')
# cameras: pulled back to fit both arms and their jobs
sub('look((-0.95, 0.18, 0.52), (0.0, 0.0, 0.03)); cam.data.lens = 30', 'look((-1.45, 0.62, 1.00), (0.0, 0.05, 0.22)); cam.data.lens = 30')
sub('cam.data.ortho_scale = 1.0; look((-2.0, 0, 0.045), (0, 0, 0.045)); res = (1500, 1000)',
    'cam.data.ortho_scale = 1.75; look((-2.0, 0.08, 0.33), (0, 0.08, 0.33)); res = (1500, 1150)')
sub('cam.data.ortho_scale = 0.78; cam.location = (0, 0.0, 2)', 'cam.data.ortho_scale = 1.45; cam.location = (-0.12, 0.1, 2)')
sub('elif VIEW == "corner":', '''elif VIEW == "front":
    look((-0.95, 1.55, 0.85), (-0.05, 0.05, 0.25)); cam.data.lens = 32
elif VIEW == "corner":''')
sys.argv = [sys.argv[0], "--", VIEW]
exec(compile(src, FRAME, "exec"), {"__name__": "__main__", "__file__": FRAME})
