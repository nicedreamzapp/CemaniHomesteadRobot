# Adds plain-English callouts to the cemani_frame_v3.py renders and writes iso/side/top/corner.jpg into docs/rebuild-2026/frame-v3/
# Run after the 4 Blender renders: python3 callouts.py
import json, os
from PIL import Image, ImageDraw, ImageFont
R = "/tmp/cemani/render3/"
OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 30)
TEXT = {
 "bearingL": "UCF204 flange bearing", "bearingR": "UCF204 bearing (under 2 rails)",
 "pinR": "3/4 x 2 in clevis pin (kingpin)", "collarR": "Clamp collar under the plate",
 "plateL": "1/4 in steering plate", "plateR": "Steering plate (actuator hole)",
 "standoffR": "15 mm standoffs", "inrailR": "Inboard 2020 rail",
 "blackplate": "Black plate (on standoffs)", "blackR": "Black plate (on standoffs)",
 "tierod": "Tie rod", "tierodR": "Tie rod (5/16 rod, heim ends)",
 "actuator": "Steering actuator", "actend": "Actuator pushes the right plate",
 "stub": "2020 stub + bracket (left rail)",
 "tallbox": "Tall box (back)", "lowbox": "Low box (front)", "midrail": "Middle rail ring",
 "gusset": "Gusset plates", "inner": "Inner bottom rail", "blacktop": "Black top rails",
 "shock": "Coil-over shock", "shockR": "Coil-over shock", "arm": "Twin swing arm", "armR": "Twin swing arm",
 "wheel": "8 in hub motor wheel",
}
def draw(img, out, keys, margin=470):
    im = Image.open(R + img).convert("RGB"); w, h = im.size
    pts = json.load(open(R + img.replace(".png", ".json")))
    c = Image.new("RGB", (w + 2*margin, h), "white"); c.paste(im, (margin, 0))
    d = ImageDraw.Draw(c)
    items = sorted([(pts[k][1]*h, pts[k][0]*w + margin, k, side) for k, side in keys])
    used = {"L": [], "R": []}
    for y, x, k, side in items:
        ty = y
        while any(abs(ty - u) < 46 for u in used[side]): ty += 46
        used[side].append(ty)
        t = TEXT[k]; tw = d.textlength(t, font=F)
        tx = 12 if side == "L" else w + 2*margin - tw - 12
        ex = tx + tw + 8 if side == "L" else tx - 8
        d.line([(ex, ty), (x, y)], fill=(200, 30, 30), width=4)
        d.ellipse([x-9, y-9, x+9, y+9], fill=(200, 30, 30), outline="white", width=3)
        d.text((tx, ty - 18), t, font=F, fill=(20, 20, 20))
    c.save(os.path.join(OUT, out), quality=88)
draw("iso.png", "iso.jpg", [("lowbox", "L"), ("bearingL", "L"), ("plateL", "L"), ("shock", "L"), ("wheel", "L"),
     ("blacktop", "R"), ("tallbox", "R"), ("midrail", "R"), ("gusset", "R"), ("stub", "R")])
draw("side.png", "side.jpg", [("bearingL", "L"), ("plateL", "L"), ("blackplate", "L"), ("wheel", "L"),
     ("actuator", "R"), ("stub", "R"), ("tallbox", "R"), ("midrail", "R")])
draw("top.png", "top.jpg", [("plateL", "L"), ("tierod", "L"), ("inner", "L"), ("actuator", "R"), ("plateR", "R"), ("blacktop", "R")], 400)
draw("corner.png", "corner.jpg", [("bearingR", "L"), ("plateR", "L"), ("collarR", "L"), ("standoffR", "L"), ("blackR", "L"), ("shockR", "L"), ("armR", "L"),
     ("tierodR", "R"), ("actend", "R"), ("inrailR", "R")])
