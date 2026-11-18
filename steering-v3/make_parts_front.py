"""Builds parts-front.html from the rows below. Status: cart | not | have."""
import html, os
HERE = os.path.dirname(os.path.abspath(__file__))
A = lambda a: f"https://www.amazon.com/dp/{a}"
BUY = [
 # qty, image, part, size note, where label, link, status, status note
 ("2", "ucf204.png", "UCF204-12 flange bearing", "3/4 in bore. Caliper the 4 bolt holes on arrival (plan 64 mm square)", "eBay $9.99 each (Carnell Sales)", "https://www.ebay.com/itm/170523091215", "cart", ""),
 ("2", "clevis_pin.png", "Clevis pin 3/4 x 2 in", "Steel, 2 in under the head (fits 50.8 to 54.3 mm). No cotter needed. NOT the 2-3/4 in one", "Zoro $4.75 each (G3393796)", "https://www.zoro.com/zoro-select-standard-clevis-pin-34-in-dia-steel-1-pk-u397970750200/i/G3393796/", "not", "Zoro page open, qty 2 set: click Add to Cart"),
 ("2", "", "Face-mount collar, 3/4 in bore", "Ruland FHT-MCL-12E-F (3/4 in bore confirmed): 40 OD x 15 wide, 2 tapped M6 face holes", "Zoro $12.79 each", "https://www.zoro.com/ruland-shaft-collar-mountable-fht-mcl-12e-f/i/G708673879", "cart", "Zoro cart, qty 2"),
 ("4", "", "M6 x 16 flat head screws", "Stainless. Collar to steering plate, from below", "Amazon 20 pk", A("B09Y5PLLGD"), "cart", ""),
 ("8", "m5x18_bearing_bolt.png", "M5 x 18 socket head screws", "Stainless. Bearing to frame", "Amazon 20 pk", A("B019ETH1CC"), "cart", ""),
 ("8", "step_sleeve_12od_5p2id.png", "Sleeves 12 OD x 5.2 ID x 10 long", "Aluminium, in the bearing bolt holes", "Amazon 10 pk", A("B0BYT4HFFZ"), "cart", ""),
 ("8", "washer.png", "M5 flat washers", "Stainless", "Amazon 100 pk", A("B0DDH3QNH4"), "cart", ""),
 ("24", "tnut.png", "M5 drop-in T-nuts for 2020", "8 bearings + 16 L brackets / actuator bracket", "Amazon kit (120 T-nuts)", A("B0DMCS8KW4"), "cart", ""),
 ("8", "", "Standoffs 10 OD x 15 long, M5", "Steel, one piece (no 10 + 5 stacking). 4 per corner, black plate to steering plate", "Amazon 10 pk $8.99", A("B0D3PW2WJP"), "not", "add this; delete the two PATIKIL 6 packs"),
 ("8", "", "M5 x 40 socket head screws", "Stainless. Up through black plate, standoff, steering plate; fender washer + nylock on top", "Amazon 25 pk", A("B094HQMSQF"), "cart", ""),
 ("2 + 2", "bolt_5-16x1.5_hex.png", "5/16-18 x 1-1/2 bolts + nylock nuts", "304 stainless. Heim joints", "Amazon 10 sets $8.99", A("B0H3986MBQ"), "not", "add this; delete the $21.99 20 set kit"),
 ("2", "heim_spacer_5-16x8.png", "Spacers 5/16 ID x 16 OD x 8 long", "Under each heim", "Amazon 5 pk", A("B0CBJGC6TK"), "cart", ""),
 ("1 + 1", "bolt_1-4x1.5_hex.png", "1/4-20 x 1-1/2 bolt + 1/4 nylock", "Actuator front end", "Amazon 10 sets", A("B081FDPMXS"), "cart", ""),
 ("2", "3_heim_joint_cf5.jpg", "Heim joints CF5", "5/16 bore, 5/16-24 RH female, jam nuts included", "Amazon 2 pk $9.99", A("B0C9Y6S5CP"), "cart", ""),
 ("1 + 1", "steering_plate_right.png", "Steering plates, left + right", "1/4 in, laser cut (Fix A DXF update pending)", "laser shop", "", "not", "after bearings + collars are calipered"),
]
HAVE = [
 ("5 pcs", "2020_inboard_rail.png", "2020 extrusion", "2 inboard rails 110.9 mm, 2 cross pieces 44 mm, 1 actuator stub 110 mm"),
 ("7", "2020_L_bracket.png", "2020 L brackets", ""),
 ("1", "9_glideforce_lact4p_actuator.jpg", "Glideforce actuator", "246-346 mm"),
 ("1", "10_glideforce_bracket_aluminum.jpg", "Actuator bracket", "with pin"),
 ("1", "4_tie_rod_5-16-24.jpg", "Tie rod 5/16-24 x 200 mm", "uncut, 246 mm eye to eye"),
 ("-", "9a_m5x20_fender_washer.jpg", "M5 fender washers + M5 lock nuts", "packs"),
 ("2", "black_shock_plate.png", "Black plates, shocks, hub motor wheels", "on the robot"),
]
CHIP = {"cart": '<span class="buy">IN CART</span>', "not": '<span class="wait">NOT YET</span>', "have": '<span class="have">HAVE</span>'}
e = html.escape
def img(f): return f'<img src="parts-front-img/{f}">' if f else ""
rows = "".join(
    f'<tr><td class="q">{e(q)}</td><td>{img(i)}</td><td><b>{e(p)}</b><br><small>{e(n)}</small></td>'
    f'<td>{CHIP[s]}{"<br><small>"+e(sn)+"</small>" if sn else ""}</td>'
    f'<td>{f"<a href=\"{l}\">{e(w)}</a>" if l else e(w)}</td></tr>' for q, i, p, n, w, l, s, sn in BUY)
have = "".join(f'<tr><td class="q">{e(q)}</td><td>{img(i)}</td><td><b>{e(p)}</b><br><small>{e(n)}</small></td><td>{CHIP["have"]}</td></tr>' for q, i, p, n in HAVE)
page = f"""<!doctype html><html><head><meta charset="utf-8"><title>Cemani front steering: parts</title>
<style>body{{font:17px -apple-system,system-ui,sans-serif;background:#16181d;color:#eee;margin:24px;max-width:1100px}}
h1{{font-size:24px;margin:0 0 4px}}p.sub{{color:#9aa;margin:0 0 18px}}h2{{font-size:18px;margin:26px 0 8px;color:#f0b44c}}
table{{border-collapse:collapse;width:100%}}td,th{{padding:9px 10px;border-bottom:1px solid #2c3038;vertical-align:middle;text-align:left}}
th{{color:#9aa;font-weight:600;font-size:14px}}td.q{{font-weight:700;white-space:nowrap}}img{{height:56px;border-radius:6px;background:#fff}}
.buy{{background:#f0b44c;color:#111;border-radius:10px;padding:2px 9px;font-size:13px;font-weight:700}}
.have{{background:#3c8d5a;color:#fff;border-radius:10px;padding:2px 9px;font-size:13px;font-weight:700}}
.wait{{background:#555;color:#fff;border-radius:10px;padding:2px 9px;font-size:13px;font-weight:700}}a{{color:#7fb6ff}}small{{color:#9aa}}
.note{{background:#1f232b;border-radius:10px;padding:12px 16px;margin-top:10px}}.note li{{margin:4px 0}}</style></head><body>
<h1>Front steering: parts list</h1><p class="sub">2 front corners + the tie rod and actuator. Fix A design (corner-final.html), carts checked 11/17. In cart = not bought yet. No cutting, welding or drilling.</p>
<h2>Buy</h2><table><tr><th>Qty</th><th></th><th>Part, exact size</th><th>Status</th><th>Where</th></tr>{rows}</table>
<h2>Fix A stack (top to bottom)</h2><div class="note"><ul>
<li>Bearing inner ring 33 mm, steering plate 6.35 mm squeezed under it, Ruland collar 15 mm under the plate (2 M6 flat heads up into it)</li>
<li>Pin 3/4 x 2 in: head on the inner ring, ends inside the collar (fits 50.8 to 54.3 mm under the head)</li>
<li>Black plate hangs on 4 x 15 mm standoffs per corner, M5 x 40 through each</li>
<li>DXFs need the Fix A update before the laser shop</li></ul></div>
<h2>Already have</h2><table>{have}</table>
<h2>Cart changes 11/17</h2><div class="note"><ul>
<li>Clevis pins moved from eBay ($15.88 each) to Zoro 3/4 x 2 ($4.75 each). The Zoro 2-3/4 in pin (G3392369) is too long and out of stock: do not buy it</li>
<li>Two PATIKIL 6 packs (10 mm + 5 mm) only made 6 standoffs: replaced by one 10 pack of 15 mm steel standoffs</li>
<li>5/16 x 1-1/2 20 set kit ($21.99) replaced by a 10 set stainless kit ($8.99)</li></ul></div>
</body></html>"""
open(os.path.join(HERE, "parts-front.html"), "w").write(page)
print("ok")
