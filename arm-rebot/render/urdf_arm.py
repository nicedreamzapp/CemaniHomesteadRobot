# Minimal URDF loader for Blender: builds the reBot B601-DM from Seeed's URDF + colored visual STLs at given joint angles.
import bpy, math, os, xml.etree.ElementTree as ET
from mathutils import Matrix, Vector, Euler

def _origin(el):
    o = el.find("origin") if el is not None else None
    xyz = [float(v) for v in (o.get("xyz", "0 0 0") if o is not None else "0 0 0").split()]
    rpy = [float(v) for v in (o.get("rpy", "0 0 0") if o is not None else "0 0 0").split()]
    return Matrix.Translation(Vector(xyz)) @ Euler(rpy, "XYZ").to_matrix().to_4x4()

def build(urdf_path, mesh_root, base_matrix, angles=None, parent=None):
    angles = angles or {}
    root = ET.parse(urdf_path).getroot()
    mats = {}
    for m in root.findall("material"):
        c = m.find("color")
        if c is not None:
            rgba = [float(v) for v in c.get("rgba").split()]
            bm = bpy.data.materials.new("urdf_" + m.get("name")); bm.use_nodes = True
            b = bm.node_tree.nodes["Principled BSDF"]
            b.inputs["Base Color"].default_value = rgba
            b.inputs["Roughness"].default_value = 0.4; b.inputs["Metallic"].default_value = 0.3
            mats[m.get("name")] = bm
    links = {l.get("name"): l for l in root.findall("link")}
    joints = root.findall("joint")
    child_of = {j.find("child").get("link"): j for j in joints}
    world = {}
    def link_world(name):
        if name in world: return world[name]
        j = child_of.get(name)
        if j is None: world[name] = base_matrix; return base_matrix
        pm = link_world(j.find("parent").get("link"))
        a = angles.get(j.get("name"), 0.0)
        ax = Vector([float(v) for v in j.find("axis").get("xyz").split()]) if j.find("axis") is not None else Vector((0, 0, 1))
        if j.get("type") == "revolute" or j.get("type") == "continuous":
            mv = Matrix.Rotation(a, 4, ax)
        elif j.get("type") == "prismatic":
            mv = Matrix.Translation(ax * a)
        else:
            mv = Matrix.Identity(4)
        world[name] = pm @ _origin(j) @ mv
        return world[name]
    objs = []
    for name, l in links.items():
        M = link_world(name)
        for v in l.findall("visual"):
            mesh = v.find("geometry/mesh")
            if mesh is None: continue
            fn = os.path.join(mesh_root, mesh.get("filename").split("meshes/")[-1])
            if not os.path.exists(fn): continue
            before = set(bpy.data.objects)
            bpy.ops.wm.stl_import(filepath=fn)
            new = [o for o in bpy.data.objects if o not in before]
            mref = v.find("material")
            for o in new:
                o.matrix_world = M @ _origin(v)
                if mref is not None and mref.get("name") in mats:
                    o.data.materials.clear(); o.data.materials.append(mats[mref.get("name")])
                if parent is not None:
                    mw = o.matrix_world.copy(); o.parent = parent; o.matrix_world = mw
                objs.append(o)
    return objs
