# reBot B601-DM mounting plate for Cemani. Units mm. Origin = arm centre (joint 1 axis).
# Arm hole patterns read from Seeed's 01_BASE_Plate.step / 01_BASE_Link.step (github.com/Seeed-Projects/reBot-DevArm):
#   4x M4 on a 64 mm square (their plate: 4.6 hole, 7.5 counterbore from below)
#   4x M3 on a 26.88 mm square (their plate: 3.2 hole, 6.2 counterbore from below)
# Plate sits on the two top cross rails of the front low box (frame v3 model: y = 135 and y = 272.5, 137.5 c-c, top at z 171),
# centred left-right. 8 x M5 slots (5.5 x 16, long along the robot) into drop-in T-nuts, so real rail spacing can be off by +-5 mm.
# 1/4 in 6061 (same as the steering plates). Screws for the arm go up from underneath, in the open gap between the rails.
from PIL import Image, ImageDraw, ImageFont
W, H = 200.0, 175.0                 # x across the robot, y along the robot
RAIL = 137.5 / 2                    # rail centres from plate centre
HOLES = [(sx*32, sy*32, 4.6, "M4") for sx in (-1, 1) for sy in (-1, 1)] + \
        [(sx*13.44, sy*13.44, 3.2, "M3") for sx in (-1, 1) for sy in (-1, 1)]
SLOTS = [(x, sy*RAIL) for x in (-80, -40, 40, 80) for sy in (-1, 1)]
SW, SL = 5.5, 16.0
CR = 10.0                           # corner radius

def dxf(path):
    L = ["0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC","0","SECTION","2","ENTITIES"]
    line = lambda a,b,c,d: L.extend(["0","LINE","8","0","10",f"{a}","20",f"{b}","11",f"{c}","21",f"{d}"])
    arc = lambda x,y,r,s,e: L.extend(["0","ARC","8","0","10",f"{x}","20",f"{y}","40",f"{r}","50",f"{s}","51",f"{e}"])
    w, h = W/2, H/2
    line(-w+CR,-h, w-CR,-h); line(w,-h+CR, w,h-CR); line(w-CR,h, -w+CR,h); line(-w,h-CR, -w,-h+CR)
    arc(w-CR,-h+CR,CR,270,360); arc(w-CR,h-CR,CR,0,90); arc(-w+CR,h-CR,CR,90,180); arc(-w+CR,-h+CR,CR,180,270)
    for x,y,d,_ in HOLES: L.extend(["0","CIRCLE","8","0","10",f"{x}","20",f"{y}","40",f"{d/2}"])
    r, hl = SW/2, (SL-SW)/2
    for x,y in SLOTS:
        line(x-r,y-hl, x-r,y+hl); line(x+r,y-hl, x+r,y+hl)
        arc(x,y+hl,r,0,180); arc(x,y-hl,r,180,360)
    L += ["0","ENDSEC","0","EOF"]; open(path,"w").write("\n".join(L)+"\n")
dxf("rebot-mount-plate.dxf")

# preview, phone friendly (portrait)
K = 4.0; PW, PH = 1000, 1250; ox, oy = PW/2, 520
im = Image.new("RGB",(PW,PH),"white"); dr = ImageDraw.Draw(im)
f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 26)
fb = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 34)
P = lambda x,y: (ox + x*K, oy - y*K)
for sy in (-1,1):   # rails underneath, dashed look
    y = sy*RAIL; dr.rectangle([P(-W/2-15, y+10), P(W/2+15, y-10)], fill=(225,225,225))
dr.rounded_rectangle([P(-W/2,H/2), P(W/2,-H/2)], radius=CR*K, fill=(200,212,228), outline=(30,30,30), width=4)
for x,y,d,lab in HOLES:
    r = d/2*K; c = P(x,y); dr.ellipse([c[0]-r,c[1]-r,c[0]+r,c[1]+r], fill="white", outline=(30,30,30), width=3)
for x,y in SLOTS:
    a = P(x-SW/2, y+SL/2); b = P(x+SW/2, y-SL/2); dr.rounded_rectangle([a,b], radius=SW/2*K, fill="white", outline=(30,30,30), width=3)
dr.text((40,30), "reBot arm mounting plate, 1/4 in 6061", font=fb, fill="black")
dr.text((40,80), "200 x 175 mm, sits on the 2 top rails of the front low box", font=f, fill="black")
notes = ["Front of robot is UP in this picture",
         "Arm base sits centred over the 8 middle holes",
         "4 M4 holes, 64 mm square: arm base screws, from below",
         "4 M3 holes, 26.9 mm square: arm base screws, from below",
         "8 M5 slots into drop-in T-nuts (4 per rail)",
         "Grey bands = the 2 rails, 137.5 mm apart (centre to centre)",
         "Slots allow +-5 mm if the real rails measure different"]
for i,t in enumerate(notes): dr.text((40, 900+i*44), t, font=f, fill="black")
im.save("rebot-mount-plate.png")
print("ok")
