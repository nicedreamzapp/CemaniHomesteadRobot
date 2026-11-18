# Cemani front steering CAD (2 front corners + front axle)

Real parametric model (OpenCascade via cadquery 2.8). Units mm. x = right, y = forward, z = up, z = 0 is the bottom face of the 2020 frame.
Rebuild: `~/.local/cadenv/bin/python build_front_cad.py` (edit DIMS / FRAME / CAT at the top). Renders: `node render.mjs`, then `~/.local/cadenv/bin/python make_index.py`.

## Files
- `front_steering_assembly.step`: full assembly, every solid named and colored, straight-ahead pose
- `parts/*.step`: one STEP per unique part; `parts/steering_plate_left.dxf` / `_right.dxf`: laser-cut outlines
- `front_steering_assembly.glb` / `.stl`: for viewing; `corner_right_exploded.glb`
- `viewer.html`: spin it, click a part in the list to highlight, click again to isolate (works from file://, data in viewer_data.js)
- `renders/`: iso, front, top, exploded_corner; `renders/parts/`: each part alone + in place, `index.json`
- `clash_report.json`: interference + clearances at 0 and +/-30 deg; `CHECK.md`: the measurement check (OK / WRONG per item)

## Parts (front only)
source: buy = order it, have = already on the robot / bought, laser-cut = cut from DXF, placeholder = stand-in until picked

| Part (STEP name) | Qty | Source | Size / note |
|---|---|---|---|
| 2020_side_rail_front_portion | 2 | have | existing frame rail, front 350 mm shown |
| 2020_cross_rail_265 | 2 | have | existing frame cross rail |
| 2020_inboard_rail | 2 | buy | 2020 cut to 110.9 mm |
| 2020_cross_piece | 2 | buy | 2020 cut to 44 mm |
| 2020_L_bracket | 7 | buy | 20x20 corner bracket, 3 mm, simplified (no screw holes) |
| tnut_m5_2020 | 8 | buy | standard M5 drop-in T-nut for 2020 (simplified section) |
| step_sleeve_12od_5p2id | 8 | buy | 12 OD x 5.2 ID x 12 L aluminium (10 L is safer if the ear is under 12) |
| washer_m5 | 8 | buy | M5 flat 10 OD |
| m5x18_bearing_bolt | 8 | buy | ISO 4762 socket head |
| ucf204-12_housing | 2 | buy | catalog dims, caliper on arrival |
| ucf204_zerk | 2 | buy | comes with bearing |
| ucf204-12_insert | 2 | buy | comes with bearing, 3/4 in bore |
| ucf204_set_screw | 4 | buy | comes with bearing |
| clevis_pin_3-4x2-1-2_cut | 2 | buy | 3/4 x 2-1/2 clevis pin, grip 57.5, cut to 52.0 under head |
| clamp_collar_3-4_double_split_half | 4 | buy | 3/4 double-split clamp collar, 1-1/2 OD x 1/2 wide (2 halves = 1 collar); drill + tap 1 x M5 per half |
| collar_clamp_screw_M5x22 | 4 | buy | comes with the collar |
| collar_to_plate_M5x12_flathead | 4 | buy | locks the plate to the collar (torque + holds the plate up); countersunk under the plate |
| steering_plate_left | 1 | laser-cut | 1/4 in (6.35) aluminium |
| black_shock_plate | 2 | have | 56 x 100 x 6, 4 holes 41 x 65.5 (tape reading) |
| screw_M5x25_SHCS | 8 | buy | ISO 4762 |
| fender_washer_M5x20 | 8 | have | 5.3 / 20 / 1.2 |
| nylock_M5 | 8 | have | 8 AF x 5 |
| shock_module_envelope | 2 | have | fit envelope only, not for manufacture |
| wheel_8in_hub_motor_envelope | 2 | have | 8 in tire, 56 wide, fit envelope only |
| bolt_5-16x1.5_hex | 2 | buy | 5/16 x 1-1/2 (1-1/4 too short with the 8 mm spacer) |
| heim_spacer_5-16x8 | 2 | buy | 5/16 ID x 16 OD x 8 mm spacer (or washer stack): lifts the heim clear of the plate and the M5 nuts |
| nylock_5-16 | 2 | buy | 1/2 AF |
| steering_plate_right | 1 | laser-cut | 1/4 in (6.35) aluminium |
| bolt_1-4x1.5_hex | 1 | buy | 1/4 x 1-1/2 (was 1-1/4, too short) |
| nylock_1-4 | 1 | buy | 7/16 AF |
| 2020_actuator_stub | 1 | buy | 2020 cut to 110 mm |
| actuator_rear_pin_bracket_PLACEHOLDER | 1 | placeholder | stands in for the LA-LD bracket, vertical pin |
| pin_6.35x40 | 1 | have | comes with LA-LD bracket |
| heim_CF5_5-16-24_RH | 2 | have | CF5 5/16 bore, 5/16-24 RH female |
| tie_rod_5-16-24 | 1 | have | Matt's 200 mm rod, uncut: 246.0 eye to eye, 11.9 mm into each heim |
| jam_nut_5-16-24 | 2 | buy | come with the heims |
| actuator_LACT4P_body | 1 | have | Glideforce LACT4P-12V-10, simplified from the drawing |
| actuator_LACT4P_rod | 1 | have | shown at 269.0 mm pin to pin |

## Design changes on 11/16 (from sourcing + CHECK.md)
- Bearing to frame: **M5** (2020 standard) drop-in T-nuts, M5 washers, step sleeves 12 OD x 5.2 ID (M6 drop-ins don't fit a 2020 6 mm slot). Bolt length **M5 x 18**: an M5 x 30 runs 11.4 mm into the solid rail core (set `m5bL=30` to see the clash).
- Pin: 3/4 x 2-1/2 clevis pin, head on top of the bearing inner ring, **cut to 52 mm under the head** (as bought it hits the black plate and the shock top eye).
- Collar: 3/4 double-split clamp collar (no flange). The plate is locked to it with 2 M5 x 12 flat heads into a tapped hole in each half.
- Tie rod: Matt's 200 mm rod uncut, 246 mm eye to eye, arm holes moved ahead of the axle (12.5 out, 57.3 forward) on a front tab of each plate. Each heim gets an 8 mm spacer and a 5/16 x 1-1/2 bolt.
- Actuator eye 11 mm under the plate (its rod is 20 mm thick), level with the back pin; front bolt 1/4 x 1-1/2.

## Kinematics (right wheel driven by the actuator, left solved from the tie rod)
- straight: actuator 269.0 mm pin to pin
- right wheel +30: left 33.9 deg, actuator 304.8 mm
- right wheel -30: left -27.0 deg, actuator 258.2 mm  (actuator range 246-346)

## Assumed values (catalog / drawing, caliper on arrival)
- UCF204-12 (standard catalog): 86 square, 4 holes 12 mm on a 64 mm square, flange 12 thick (catalog 11-12), housing height 26 (catalog 25.5), overall 33 with insert (catalog A0 33.3), insert OD 29, boss 56 dia, 2 set screws, zerk on the boss.
- Clevis pin 3/4 x 2-1/2: head 1-1/8 OD x 1/4, grip 57.5 (listing), cross hole 4.8.
- Clamp collar: 3/4 ID x 1-1/2 OD x 1/2 wide, 2 x M5 clamp screws (stand-in for the cart's AZSSMUK / McMaster 6436K16 size).
- LACT4P: from parts/9_actuator_dimension_drawing_feedback.png. Rear tab 20 x 18 x 18, hole 12 from the gearbox face, gearbox 82 x 42, motor 40 dia parallel to the tube, tube 30.5 dia, rod 20 dia.
- CF5 heim: listing table (22.23 head, 11.1 ball, 12.7 shank, 34.93 center to end, 17.45 thread depth).
- 2020: B-type 6 mm slot profile, 5.6 mm slot depth to the core.
- Black plate 56 x 100 x 6 with holes 41 x 65.5 (tape readings and viewer). The shock module and wheel are envelopes copied from the viewer's guesses: for fit only, not for manufacture.

## Known open items
- The LA-LD bracket's pin is parallel to its base, so screwed flat under the stub its pin would be horizontal. The actuator needs a vertical pin, so the CAD shows a placeholder vertical-pin clevis.
- The black-plate screw heads sit inside the guessed shock upright envelope. That's a flaw in the envelope, not a real clash; check it on the robot.
- `make_plates.py` / its DXFs are the old 10/21 kingpin plates. Use `parts/steering_plate_*.dxf` from this CAD instead (cut only after the bearings and collar are calipered).
