# Cemani, up-to-date plan: frame v3 sized to the real frame, 4-wheel steering (rear axle = the front axle mirrored, steering
# the opposite way for tight turns), and the reBot B601-DM on its plate on the front low box.
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
''' % POSE
sub("# Front-only for now", EXTRA + "\n# Front-only for now")
sub('OUT = "/tmp/cemani/render3"', 'OUT = "/tmp/cemani/render_arm"')
# cameras: pulled back to fit the arm
sub('look((-0.95, 0.18, 0.52), (0.0, 0.0, 0.03)); cam.data.lens = 30', 'look((-1.25, 0.45, 0.80), (0.0, 0.03, 0.12)); cam.data.lens = 30')
sub('cam.data.ortho_scale = 1.0; look((-2.0, 0, 0.045), (0, 0, 0.045)); res = (1500, 1000)',
    'cam.data.ortho_scale = 1.45; look((-2.0, 0.08, 0.22), (0, 0.08, 0.22)); res = (1500, 1150)')
sub('cam.data.ortho_scale = 0.78; cam.location = (0, 0.0, 2)', 'cam.data.ortho_scale = 1.0; cam.location = (0, 0.05, 2)')
sub('elif VIEW == "corner":', '''elif VIEW == "front":
    look((-0.75, 1.15, 0.55), (0.0, 0.05, 0.12)); cam.data.lens = 32
elif VIEW == "corner":''')
sys.argv = [sys.argv[0], "--", VIEW]
exec(compile(src, FRAME, "exec"), {"__name__": "__main__", "__file__": FRAME})
