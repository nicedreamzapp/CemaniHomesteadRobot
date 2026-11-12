# Steering plates for laser cutting. Units: mm. Pivot at (0,0). u = outward, v = toward the frame end.
# Black plate hole pattern read off the 10/15 tape photos.
import sys
from PIL import Image, ImageDraw, ImageFont
BP_U, BP_V, BP_CU = 42.0, 63.0, -12.0      # read off IMG_7734 (across ~42 mm) and IMG_7735 (along ~63 mm), 10/15 tape photos; holes 7.5 mm so +-1.25 mm still fits M5
OUT = [(-42, 42), (38, 42), (38, -70), (14, -95), (-42, -95)]
def holes(right):
    h = [(0, 0, 12.5, "pivot (countersink for M12 flat head)")]
    for du in (-BP_U/2, BP_U/2):
        for dv in (-BP_V/2, BP_V/2): h.append((BP_CU+du, dv, 7.5, "black plate screw M5, oversize for fit"))
    h.append((-17.8, -57.3, 8.2, "tie rod 5/16"))
    if right: h.append((-25.0, -85.0, 6.6, "actuator pin 1/4"))
    return h
def dxf(path, mirror, right):
    s = lambda u: -u if mirror else u
    L = ["0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC","0","SECTION","2","ENTITIES"]
    pts = OUT + [OUT[0]]
    for (a,b),(c,d) in zip(pts, pts[1:]):
        L += ["0","LINE","8","0","10",f"{s(a)}","20",f"{b}","11",f"{s(c)}","21",f"{d}"]
    for u,v,dia,_ in holes(right):
        L += ["0","CIRCLE","8","0","10",f"{s(u)}","20",f"{v}","40",f"{dia/2}"]
    L += ["0","ENDSEC","0","EOF"]; open(path,"w").write("\n".join(L)+"\n")
dxf("steer-plate-left.dxf", True, False)
dxf("steer-plate-right.dxf", False, True)
# preview
K=4.2; W,H=900,900
im=Image.new("RGB",(W,H),"white"); dr=ImageDraw.Draw(im)
f=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf",20); fb=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf",24)
for k,(mir,right,ox,name) in enumerate([(True,False,220,"LEFT plate"),(False,True,660,"RIGHT plate")]):
    s=lambda u: -u if mir else u; P=lambda u,v:(ox+s(u)*K, 260-v*K)
    dr.polygon([P(u,v) for u,v in OUT], fill=(205,215,228), outline=(40,40,40), width=3)
    for u,v,d,_ in holes(right):
        x,y=P(u,v); r=d/2*K; dr.ellipse([x-r,y-r,x+r,y+r], fill="white", outline="black", width=2)
    dr.text((ox-60,40),name,font=fb,fill="black")
leg=["Big center hole: the pivot bolt (countersunk)","4 small holes: your black plate's screws","Hole near the angled corner: tie rod","Right plate only, last hole: actuator pin","1/4 in aluminum, about 3 1/8 x 5 3/8 in"]
for i,t in enumerate(leg): dr.text((40,740+i*28),t,font=f,fill="black")
im.save("plates-preview.png")
