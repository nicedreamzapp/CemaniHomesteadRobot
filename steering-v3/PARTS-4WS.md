# 4-wheel-steering parts list (2026-11-16)

Design: 4 identical corners (UCF204-12 on 4 M6 bolts into T-nuts under the side rail + a 2nd 2020 rail 64 mm inboard), 3/4 in shaft, 3/4 in flanged collar, 1/4 in steering plate, existing black plate. 2 axles, each with 1 tie rod (2 heim joints) and 1 actuator.
OUT of this build (do not buy): KFL001, AXK1226, M12 countersunk bolts/nuts, 1.5 in spacers, M5x50 screws, UCF205 / 1 in parts.
"UNVERIFIED" = no real price or listing found, nothing invented. Counts are from the viewer (corner(), axle()) and steps-4ws.js.

## ALREADY HAVE (from specs.json = old and kept parts; "check" = confirm it is physically in hand)

| Qty | Part | Status |
|---|---|---|
| 4 | Black plates with shock, arm and wheel (existing robot) | have |
| 2 | Heim joints CF5 5/16 x 5/16-24 RH female (Amazon B0C9Y6S5CP, 2-pack with jam nuts, specs.json item 3) | have, check bought. Need 4, so buy 1 more 2-pack |
| 2 | Tie rods, 5/16-24 304 SS threaded rod, 200 mm (Amazon B0FRSM7CQ9, 2-pack, item 4) | have, check bought. Covers both axles |
| 1 | Glideforce LACT4P-12V-10 actuator, 246-346 mm, 4 in stroke, feedback (Pololu 3645, item 9) | have, check. Need 2, so buy 1 more |
| 1 | Glideforce LA-LD-BRACKET (Pololu 2314, item 10) | check. Need 1 per axle (2 total), so buy 1 more |
| 16 | M5 fender washers 20 mm OD (Amazon B0H4Q6ZB36, 50-pack, item 9a) | check, enough in the pack |
| 16 | M5 nylon lock nuts, 304 SS (Amazon B0D1468L8Y, 100-pack, item 9b) | check, enough in the pack |
| - | Existing frame: side rails, front and back cross rails, 2020 stock, shocks and wheels | have |

## TO BUY

Verified prices (real listings):

| Qty | Part | Exact size | Where | Link | Price | Line total |
|---|---|---|---|---|---|---|
| 2 packs (4 bearings) | UCF204-12 4-bolt square flange bearing, 3/4 in bore (86 mm square, 64 mm bolt square catalog values, caliper on arrival) | UCF204-12, 2-pack | eBay | https://www.ebay.com/itm/170523091215 (backup https://www.ebay.com/itm/127025890787 $21.40) | $19.98 per 2-pack, free ship | $39.96 |
| 1 | Glideforce LACT4P-12V-10 actuator (2nd axle) | 246-346 mm, 12 V, feedback | Pololu | https://www.pololu.com/product/3645 | $194.88 (backorder allowed, no stock count shown) | $194.88 |
| 1 | Glideforce LA-LD-BRACKET (2nd axle actuator bracket; pin 6.35 mm included) | 38 x 39.6 mm base | Pololu | https://www.pololu.com/product/2314 | $24.07 | $24.07 |
| | **Verified subtotal** | | | | | **$258.91** |

Unpriced lines (price UNVERIFIED, no source confirmed this session):

| Qty | Part | Exact size | Where / link | Price |
|---|---|---|---|---|
| 4 | 3/4 in flanged collar | see COLLAR section | see below | UNVERIFIED (about $56-$120 each, see below) |
| 4 | Steering plates, laser cut, 1/4 in (6.35 mm) aluminum (plates from make_plates.py DXFs: 2 left + 2 right style; 1 extra hole for actuator on 1 plate per axle, see steps 9 and 19; add 4 collar flange holes once the collar is chosen) | about 3 1/8 x 5 3/4 in | laser shop | UNVERIFIED, no quote |
| 4 | 3/4 in steel shaft, bought pre-cut. Viewer shaft length is about 49 mm, so 2 in (50.8 mm); confirm against the bearing and collar width | 3/4 in dia x 2 in | UNVERIFIED. No 3/4 x 2 in cut piece found; Zoro 3/4 in 1018 12 in bar $5.29 (https://www.zoro.com/zoro-select-carbon-steel-rod-12-in-l-34-in-dia-4795120/i/G102644574/) would need cutting, which Matt does not do | UNVERIFIED |
| 4 | 2nd inboard 2020 rail, about 4.5 in (about 115 mm; viewer length from yAxle-70 to the front cross rail) | 2020 | UNVERIFIED | UNVERIFIED |
| 4 | Short 2020 cross piece between rails, 108 mm (2 x 64 - 20) | 2020 | UNVERIFIED | UNVERIFIED |
| 2 | Actuator mount stub, 110 mm 2020 (one under the left side rail front, one under the right side rail back) | 2020 | UNVERIFIED | UNVERIFIED |
| 14 | 2020 L brackets (3 per corner: 1 to the cross rail, 2 for the cross piece = 12, plus 1 per stub = 2) | 20 x 20 L bracket | UNVERIFIED | UNVERIFIED |
| 28 | M5 x 10 screws for L brackets (2 each) | M5 x 10 | UNVERIFIED | UNVERIFIED |
| 4 | M5 x 12 screws for actuator brackets (2 per bracket) | M5 x 12 | UNVERIFIED | UNVERIFIED |
| 32 | M5 drop-in T-nuts for 2020 (28 for L brackets + 4 for the 2 actuator brackets) | M5, 2020 | UNVERIFIED | UNVERIFIED |
| 16 | M6 drop-in T-nuts for 2020 (4 per corner) | M6, 2020 slot | UNVERIFIED (only a desertcart 100-pack M6 listing seen, no price) | UNVERIFIED |
| 16 | M6 bolts with washers for the bearings, about 30 mm (viewer screw(6,30)). Ears 12 mm + washer + rail wall, confirm length with caliper | M6 x 30 | UNVERIFIED | UNVERIFIED |
| 16 | Step sleeves (fill the bearing's bigger 12 mm holes) | about 12 mm OD, 12 mm long, 6.4 mm ID | UNVERIFIED, may need a spacer pack | UNVERIFIED |
| 16 | M6 flat washers | M6 | UNVERIFIED | UNVERIFIED |
| 16 | M5 x 25 screws for black plates (FIT_CHECK says 8 front, now all 4 corners; confirm old screws are too long/short) | M5 x 25, SS | UNVERIFIED | UNVERIFIED |
| 4 | 5/16 bolts about 1 1/4 in (32 mm) for heim joints to steering arms | 5/16 x 1-1/4 | UNVERIFIED | UNVERIFIED |
| 4 | 5/16 nylon lock nuts | 5/16 | UNVERIFIED | UNVERIFIED |
| 1 pack | Heim joints CF5 5/16-24 RH female, 2-pack with jam nuts (to make 4) | CF5 | https://www.amazon.com/dp/B0C9Y6S5CP | UNVERIFIED (price not in specs.json) |
| 2 | 1/4 in bolts about 1-1/4 in (32 mm) for actuator front end to steering plate (1 per axle) | 1/4 x 1-1/4 | UNVERIFIED | UNVERIFIED |
| 2 | 1/4 in nylon lock nuts | 1/4 | UNVERIFIED | UNVERIFIED |
| 4 | Collar-to-plate bolts: 2 per collar x 4 = more; size depends on collar (1/4 in, see below) | 1/4 in | UNVERIFIED | UNVERIFIED |

Back-actuator pivot pin hardware: bracket pin and R-clip come with the Pololu bracket.

## COLLAR: 3/4 in (19.05 mm) bore flanged / flange-mount shaft collar, qty 4

Flanged 3/4 in bore collars exist, but only as industrial parts: none is cheap, none is small, and bolt circles are not published on the pages I could read. I found no Ruland or Climax flanged 3/4 in collar, and nothing on eBay or Amazon. (The earlier ebay_deals.json note also found no cheap match for 1 in.)

| Option | Part | Flange OD | Bolt pattern | Size | Price | Link |
|---|---|---|---|---|---|---|
| A | McMaster 9684T3, black-oxide steel flange-mount collar, keyed, 3/4 in bore. Also 9692T34 (303 SS) and 9793T15 (aluminum) | 2-31/32 in (75.4 mm) | 3 tapped 1/4-20 holes + 3 unthreaded 1/4 in holes; bolt circle diameter NOT listed (get it from the McMaster drawing/CAD) | collar OD 1-3/4 in, width 1 in, 2 clamp screws | UNVERIFIED (price not shown) | https://www.mcmaster.com/flange-mount-shaft-collars |
| B | Stafford 1L012MXR, 3/4 in steel (black oxide, 1117) flanged shaft mount | 3.000 in (76.2 mm) | mounting holes 0.266 in; hole count and bolt circle NOT listed | width 1.000 in, flange 0.313 in, screws 1/4-28 x 3/4 | search snippet: $119.76, quantity price from $56.23. Ambiguous, UNVERIFIED | https://shaft-collars-couplings.staffordmfg.com/en-gb/printitem/flanged-devices-and-mounting-components/flanged-shaft-mounts/1l012mxr |
| C | Stafford 1S012AFXK Accu-Flange, 3/4 in 303 stainless, machineable, keyway | 2.980 in (75.7 mm) | holes 0.25 in and 1/4-20; count and bolt circle NOT listed | width 1.000 in, flange 0.406 in | $90.31 each (qty 1-125) = $361.24 for 4. Verified on the Stafford page | https://shaft-collars-couplings.staffordmfg.com/printitem/accu-clamp-precision-products/accu-flange--shaft-mounting-collars/1s012afxk |
| D (4 mounting holes) | Stafford 1L012AMK Accu-Mount, 3/4 in, 1-piece, flat face with 4 component mounting holes | not confirmed | 4 holes per search snippet; pattern not confirmed (page returned 403) | not confirmed | UNVERIFIED | https://www.zoro.com/stafford-34-in-1pc-accu-mount-collar-1l012amk/i/G415580804/ |

Pick: Option C (Stafford 1S012AFXK, stainless, real price, real spec page) if Matt wants one confirmed price; Option A (McMaster 9684T3) if cheaper and McMaster's real price is acceptable. Check price before ordering.

Warnings for the collar choice (these change the design):
- Real flanges are about 75 mm OD and the collar is 25 mm (1 in) wide. The 3D model assumes a 44 mm flange (colFlR 22) and a 16 mm tall collar (colH 16). Plate size, bolt holes and the gap between bearing and plate (hence shaft length and zP) need updating before plates are cut. The 75 mm flange also may not clear the black plate or the neighboring rail at full 30 degree lock.
- Fallback if the big flange does not fit: a plain 3/4 in two-piece clamp collar (e.g. Ruland ENSP35-12-SS, $34.99, 1-3/8 in OD, https://zoro.com/ruland-shaft-collar-ss-2-pcs-34in-bore-dia-ensp35-12-ss/i/G2393870) under the bearing carrying the load, with the plate clamped by a separate bolt-on hub. No small bolt-on hub was found, so this is a closest alternative and not confirmed.

## TOTAL

- Verified: **$258.91** (4 UCF204-12 bearings $39.96, 2nd actuator $194.88, 2nd bracket $24.07).
- Collar x4: $361.24 for Option C (verified), so verified total with collars is **$620.15**. Option A or B price is UNVERIFIED.
- Still UNVERIFIED and excluded from the total: laser-cut plates x4, shafts x4, heim joint 2-pack, 2020 rails/stubs/cross pieces, L brackets, M5/M6/5/16/1/4 fasteners, T-nuts, step sleeves.
