# Cemani, up-to-date plan: frame v3 sized to the real frame, 4-wheel steering (rear axle = the front axle mirrored, steering
# the opposite way for tight turns), and two reBot B601-DM arms working together: arm 1 on its plate on the front low box,
# arm 2 on a plate across the back of the tall box top, pouring a scoop of feed into the pail arm 1 is holding.
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
POSE = [float(v) for v in argv[1:7]] if len(argv) >= 7 else [0.0, -1.9, -1.15, 0.6, 0.0, 0.0]

# Arm 2 on the back of the tall box top. Pose solved offline (damped least squares on the URDF chain) so its fingertips sit at
# ARM2_TIP with the gripper pointing along ARM2_DIR; ARM1_TIP is where arm 1's fingertips land with the default POSE.
ARM2_BX, ARM2_BY = 85.0, -200.0
ARM2_POSE = [-0.111, -2.222, -1.434, -0.178, -0.091, 1.507]
ARM2_TIP = (135.0, 400.0, 420.0)
ARM2_DIR = (0.0, 0.82, -0.57)
ARM1_TIP = (0.0, 597.0, 186.0)

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
_rd = os.environ.get("REBOT_DIR", "/tmp/rebot-dl")
urdf_arm.build(os.path.join(_rd, "ReBot_Arm_DM.urdf"), os.path.join(_rd, "meshes"), _base,
               dict(zip(["joint1","joint2","joint3","joint4","joint5","joint6"], %r)))
# ---- arm 2: second reBot on a plate across the two black top rails at the back of the tall box (plate TBD) ----
BX, BY = %r, %r
BZ = ZT + 10
box("arm2_plate", 0, BY, BZ + PLATE_T/2, W, 130, PLATE_T, NEWALU)
_base2 = _M.Translation(_V((BX*S, BY*S, (BZ + PLATE_T)*S))) @ _M.Rotation(math.radians(90), 4, "Z")
urdf_arm.build(os.path.join(_rd, "ReBot_Arm_DM.urdf"), os.path.join(_rd, "meshes"), _base2,
               dict(zip(["joint1","joint2","joint3","joint4","joint5","joint6"], %r)))
# ---- the shared job: arm 1 holds a feed pail by its bail, arm 2 reaches over the body and pours a scoop of feed in ----
GALV = mat("galv", (0.70, 0.72, 0.74), 1.0, 0.32)
WOOD = mat("wood", (0.55, 0.38, 0.22), 0.0, 0.6)
SCOOP = mat("scoop", (0.55, 0.03, 0.02), 0.0, 0.45)
FEED = mat("feed", (0.78, 0.60, 0.26), 0.0, 0.85)
def cup(name, base_c, axis, r0, r1, h, m, thick=1.5, bottom=True):
    axis = _V(axis).normalized(); c = _V(base_c) + axis*(h/2)
    bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=r0*S, radius2=r1*S, depth=h*S, end_fill_type="NOTHING", location=c*S)
    o = bpy.context.object; o.name = name; o.rotation_euler = axis.to_track_quat("Z", "Y").to_euler()
    sd = o.modifiers.new("s", "SOLIDIFY"); sd.thickness = thick*S; o.data.materials.append(m)
    if bottom:
        d = cyl(name + "_bottom", *(_V(base_c) + axis*(thick/2)), r0, thick, m, verts=64)
        d.rotation_euler = o.rotation_euler
    return o
# pail: fingers of arm 1 pinch the bail wire (bail runs front to back, across the finger travel)
TIP1 = _V(%r)
PR_, PH = 92.0, 165.0                       # ~1 gal galvanized pail: 184 mm across the top, 165 tall
rim_z = TIP1.z - 108
pc = _V((TIP1.x, TIP1.y, rim_z))
cup("pail", pc - _V((0, 0, PH)), (0, 0, 1), 78, PR_, PH, GALV, 1.2)
bpy.ops.mesh.primitive_torus_add(major_radius=PR_*S, minor_radius=2.2*S, location=pc*S); _t = bpy.context.object
_t.name = "pail_rim"; _t.data.materials.append(GALV)
for sy in (-1, 1):
    cyl("pail_ear", pc.x, pc.y + sy*(PR_ + 2), rim_z - 12, 9, 3, GALV, "y", 24)
_pts = []
for i in range(25):
    t = -1 + 2*i/24
    _pts.append(_V((pc.x, pc.y + t*(PR_ + 3), rim_z - 12 + (TIP1.z + 12 - (rim_z - 12))*(1 - t*t)**0.5)))
for p0, p1 in zip(_pts, _pts[1:]): rod("bail", p0, p1, 1.6, STEEL, 10)
rod("bail_grip", _pts[11], _pts[13], 6, BLKANO, 20)
# feed already in the pail
cyl("pail_feed", pc.x, pc.y, rim_z - 60, 84, 4, FEED, verts=64)
# scoop in arm 2: handle pinched in the fingers, sticking out along the approach, red scoop cup tipped to pour
TIP2 = _V(%r); A2 = _V(%r).normalized()
h0, h1 = TIP2 - A2*35, TIP2 + A2*120
rod("scoop_handle", h0, h1, 11, SCOOP, 24)
D2 = _V((-0.25, A2.y*0.6, -0.8)).normalized()
cup("scoop_cup", h1 - D2*10, D2, 38, 46, 85, SCOOP, 2.0)
import random as _r; _r.seed(4)
lip = h1 + D2*80
for i in range(220):
    t = _r.random()
    p = lip.lerp(_V((pc.x + 35, pc.y - 15, rim_z - 55)), t)
    sp = 4 + 14*t
    p += _V((_r.uniform(-sp, sp), _r.uniform(-sp, sp), _r.uniform(-3, 3)))
    if t > 0.8 and (p.xy - pc.xy).length > PR_ - 8: continue
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=_r.uniform(1.6, 2.6)*S, location=p*S)
    g = bpy.context.object; g.name = "feed_grain"; g.data.materials.append(FEED)
''' % (POSE, ARM2_BX, ARM2_BY, ARM2_POSE, ARM1_TIP, ARM2_TIP, ARM2_DIR)
sub("# Front-only for now", EXTRA + "\n# Front-only for now")
sub('OUT = "/tmp/cemani/render3"', 'OUT = "/tmp/cemani/render_arm"')
# cameras: pulled back to fit the arm
sub('look((-0.95, 0.18, 0.52), (0.0, 0.0, 0.03)); cam.data.lens = 30', 'look((-1.45, 0.62, 1.00), (0.0, 0.05, 0.22)); cam.data.lens = 30')
sub('cam.data.ortho_scale = 1.0; look((-2.0, 0, 0.045), (0, 0, 0.045)); res = (1500, 1000)',
    'cam.data.ortho_scale = 1.55; look((-2.0, 0.12, 0.27), (0, 0.12, 0.27)); res = (1500, 1150)')
sub('cam.data.ortho_scale = 0.78; cam.location = (0, 0.0, 2)', 'cam.data.ortho_scale = 1.3; cam.location = (0, 0.2, 2)')
sub('elif VIEW == "corner":', '''elif VIEW == "front":
    look((-0.75, 1.15, 0.55), (0.0, 0.05, 0.12)); cam.data.lens = 32
elif VIEW == "corner":''')
sys.argv = [sys.argv[0], "--", VIEW]
exec(compile(src, FRAME, "exec"), {"__name__": "__main__", "__file__": FRAME})
