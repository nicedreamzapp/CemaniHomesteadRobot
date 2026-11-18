# Front steering measurement check (CAD, 2026-11-16)

Measured in the CAD (`build_front_cad.py`, OpenCascade solids, clash and distance checks at straight, +30 and -30 deg).
Stack under the frame now: bearing inner ring z -33..0, clamp collar -45.7..-33, steering plate -52.05..-45.7, black plate -58.05..-52.05.

## 1. Tie rod: the 200 mm rod + 2 CF5 heims at 246 mm eye to eye
**OK, but only with the arm holes moved to the FRONT of the axle.**
- 246 eye to eye leaves 11.9 mm of rod in each heim (heim threads are 17.45 deep). That's 1.5x the rod diameter, enough for steel. Adjust range is about 235-254 mm before you run out of thread or drop under 1x diameter.
- Rear arms (behind the axle, as now) moved outboard to 246 (arm at 12.5 out / 57.3 back): **WRONG**. The steering goes anti-Ackermann: the outer wheel turns 33.9 deg when the inner turns 30, so the tires scrub.
- Front arms (12.5 mm outboard of the pin, 57.3 mm AHEAD of the axle): **OK**. Inner 33.9 / outer 30 deg (pro-Ackermann). The tie rod runs under the front cross rail with ~25 mm to spare. This is what the CAD now uses (DIMS arm = [12.5, 57.3]); the steering plates get a front tab to carry the hole.
- Old geometry (arm 17.8 in / 57.3 back, 185 mm eye to eye) needs the rod cut to ~145 mm; it works too (inner 40.5 / outer 30).
- Clearances through +/-30 (front arms): tie rod parts never touch anything. Closest: the heim shank passes 1.5 mm over the tip of one black-plate M5 x 25 screw at full left lock (3.4 mm at full right lock). Use M5 x 20 there to get ~6.5 mm.
- Two changes this needs: an **8 mm spacer (5/16 ID) under each heim** (the CF5 shank is 12.7 thick, the ball only 11.1, so the shank rubs the plate, and at lock the heim hits the M5 washer and nut), and **5/16 x 1-1/2 bolts** (the 1-1/4 is too short with the spacer).
- Actuator is unchanged: 258.2 / 269.0 / 304.8 mm pin to pin at -30 / 0 / +30 (inside 246-346).

## 2. Clevis pin 3/4 x 2-1/2 (grip 57.5 mm), head on the bearing inner ring
**Grip: WRONG as bought. It needs to be cut.**
- Inner ring 33 + collar 12.7 + steering plate 6.35 = **52.05 mm**. The cotter hole starts at 57.5, so it falls **inside the black plate** (the black plate sits right under the steering plate, z -52.05..-58.05). There's no gap where a cotter could go.
- The as-bought pin goes 11.5 mm past the steering plate: it hits the black plate (it has no center hole, 1688 mm3 overlap) and, even if you drilled one, the shock top eye (113 mm3 overlap). The shock top eye sits only ~4.5 mm off the pin axis.
- **Fix:** cut the pin to **52 mm under the head**, ending flush with the bottom of the steering plate. That drops the cotter hole; the plate is held a different way (item 3). A 3/4 x 2 in clevis pin (50.8 under the head) also works as is: it ends 1.25 mm inside the plate, with 5.1 mm of plate on the pin.
- The head (1-1/8 OD x 1/4) sits between the two rails with ~8 mm per side. OK.

## 3. Clamp collar (no flange): how the plate locks to the pin
**Proposal (in the CAD): drill and tap one M5 into each collar half and bolt the plate to the collar from below with 2 M5 x 12 countersunk flat heads.**
- Torque path: plate -> 2 M5 -> collar (clamped on the pin) -> pin -> the bearing's 2 set screws -> inner ring. The wheel's up-load goes plate -> collar face -> inner ring face. When the robot is lifted, the plate hangs from the collar screws and the pin head hangs on the inner ring. No cotter is needed.
- Hole spots: one in the middle of each half (14.3 mm off the pin center, 90 deg from the 2 clamp screws). The collar wall there is 9.5 mm (r 9.5..19), so a 4.2 mm tap drill leaves 2.7 mm each side. Countersinks go in the plate bottom so the heads sit flush under the black plate.
- Alternative: a D-flat filed on the pin with a laser-cut D hole in the plate (keyed). That carries torque but doesn't hold the plate up, so it still needs the collar screws or a cotter. The collar-screw way is simpler.
- Not OK: "plate clamped between the collar and a cotter" (no room, see item 2).

## 4. Bearing bolts: M5 x 30 + sleeves 12 OD x 5.2 ID x 12 (or 10)
**M5 x 30: WRONG. Sleeves: OK, use 10 long.**
- Under the head there's the M5 washer (1) + bearing ear (12), so a 30 bolt reaches 17 mm above the rail face. The 2020 slot is only ~5.6 deep before the solid core, so the bolt goes **11.4 mm into the rail core** (110 mm3 per bolt in the CAD). It will bottom out before it clamps.
- **Use M5 x 18:** the tip sits at 5.0 mm (0.6 under the core) with ~3 mm into the drop-in nut. M5 x 16 also clears but only catches about 1 mm of the nut. The CAD now uses M5 x 18.
- Sleeves 12 OD x 5.2 ID: OK for the M5. **12 long only if the ear is a full 12 mm.** If the real ear is 11 (some catalogs give 11), a 12 mm sleeve stands proud and the bolt clamps the sleeve, not the bearing. 10 long is always safe. Also caliper the ear holes: if they are exactly 12.0, a 12.0 sleeve may not slide in.

## Also found
- Tire to frame: 45.4 mm straight, 32.6 mm at full lock. Tire to actuator: 59.9 mm minimum.
- The black-plate M5 screw heads sit inside the shock upright *envelope*. That's a flaw in the guessed suspension envelope (it's copied from the viewer), not a real clash. Check it on the robot.
- The LA-LD bracket's pin runs parallel to its base. Screwed flat under the stub, its pin would be horizontal, but the actuator has to swing sideways (vertical pin). The CAD shows a placeholder vertical-pin clevis; the real bracket has to go on a vertical face.
