# Front steering physics (steering-v3, Fix A), 2026-11-18

> **11/18 update: fix applied.** The right plate's actuator hole is now at (48, -63) in the DXF, the cardboard template and the 3D corner view, and the bracket pin moves about 54 mm toward the robot center (x = -176). The dead-center problem below is solved.


Source of truth used: `steering-v3/FIT_CHECK.md`, `PARTS-FRONT.md`, `PARTS-4WS.md`, `HARDWARE-INVENTORY.md`,
the DXFs in `steering-v3-view/plates/` (hole coordinates), `steering-v3-view/steps-4ws.js` (window.DIMS),
`steering-v3-view/corner-cart.html` (arm hole override, actuator direction `ad`, suspension module `SM`, pin),
and `steering-v3/viewer-4ws-ucf204.html` (bracket pin position, frame constants XR, YAX).
Calculation scripts were run in /tmp (not saved in the repo); every number below can be re-derived from the formulas shown.

## What this means (plain words)

The parts themselves are strong enough: the pin, the plates, the tie rod and the heim joints all carry several times the load they will ever see in normal driving.
The one real problem is where the actuator bolts to the right plate, because with the hole where it is drawn now the actuator loses almost all its push near 25 degrees of right turn and cannot reach full right lock.
Moving that one hole to the back outer corner of the right plate and sliding the actuator bracket about 2 inches toward the middle of the robot fixes it, and the plates are not cut yet, so this costs nothing.
The weakest part for strength is the single flange bearing, because its insert sits in a ball shaped seat that is built to tilt, so on its own it cannot hold the wheel upright against the side load of a wheel that sits 4.4 inches out from the pin.
A slippery ring (a thrust bearing or a plastic washer) filling the small gap between the steering plate and the bottom of the bearing housing lets the housing take that load and keeps the steering light.
The actuator is plenty strong when the front wheels are free to roll while it steers, and too weak if the hub motors are holding the wheels still, so the Teensy should let the front wheels creep while it steers in place.
Check one thing in hand before building: the actuator bracket pin must point straight up and down, so the bracket probably has to bolt to the side of the short 2020 piece, not the bottom.
With these changes the steering is strong, quick (about 3 seconds lock to lock) and safe on a 10 A fuse.

## 0. Geometry used (all from the repo, mm)

Coordinates are in the right steering plate frame: origin = right kingpin, +x = outboard (to the right), +y = forward.

| Item | Value | Source |
|---|---|---|
| Kingpin to kingpin (pivot track) | 221 | corner-cart.html, `ghostX = -2*(142.5-32)` |
| Wheel center to kingpin, lateral | 111.5 (black plate 11.5 + hub 100) | `D.fbpU=11.5`, `SM.hubU=100` |
| Wheel centers, track | 444.5 (17.5 in, measured) | corner-cart.html comment, viewer-turn-radius.html |
| Wheelbase | 457.2 (18 in) | viewer-turn-radius.html |
| Tire | 8 in (203 mm) pneumatic, width about 56 (model) | HARDWARE-INVENTORY.md, `SM.tireW` |
| Steering arm hole (tie rod) | (12.5, 57.3), right; (-12.5, 57.3) left, mirrored | DXFs |
| Actuator hole (right plate only) | (-25, -85), 6.6 mm | DXF right |
| Actuator bracket pin | (-230.5, -258.6) = 10.2 in behind the axle | viewer-4ws `D.pin=[-120,-30]`, XR=142.5, YAX=228.6 |
| Tie rod eye to eye | 246 | FIT_CHECK.md |
| Actuator, hole to hole | 246 retracted, 346 extended | Pololu 3645 |
| Plate | 98 x 167, 6.35 thick, 6061 | DXF outline |
| Ground to plate top (approx) | 195 = tire R 101.6 + hub 66 + black plate 6 + standoff 15 + plate 6.35 | `SM.hubZ`, `SM.tireR`, Fix A stack |

**The kingpin is vertical and the wheel sits 111.5 mm outboard of it, directly beside it (no fore and aft offset).**
So the scrub radius (kingpin offset at the ground) is 111.5 mm, about 4.4 in. That is huge compared with a car
(tens of mm) and it drives almost every result below. One good side effect: when the corner swings, the tire's
contact patch moves along the tire's own rolling direction, so the tire mostly rolls around the arc instead of
being dragged sideways. Another: the whole suspension hangs below the steering plate, so suspension travel causes
zero bump steer.

Mass, assumed (the brief says about 12 lb body; HARDWARE-INVENTORY says about 80 lb whole robot with 4 x 9 lb hub motors, 100+ lb payload tested):
- Case L (normal): 80 lb robot, 50/50 front/rear (ASSUMED), **N = 89 N per front corner**.
- Case H (loaded): 80 lb + 100 lb payload, **N = 200 N per front corner**.
- Bump factor 3 g for strength cases (ASSUMED, typical design value for a slow off road vehicle).

Tire pressure is not in the repo; ASSUMED 25 to 40 psi. Friction coefficients (peak):
dry asphalt/concrete 0.8 to 0.9, gravel 0.6, dry earth road 0.68, dry grass 0.35
([hpwizard](https://hpwizard.com/tire-friction-coefficient.html), [Engineering Toolbox](https://engineeringtoolbox.com/tractive-effort-d_1783.html)).
Design values used: mu = 0.6 for dirt/gravel/grass (conservative for grass), 0.9 for pavement.
Rolling resistance coefficient Crr: firm gravel about 0.02, loose gravel 0.04, medium hard soil 0.08, sand 0.1 to 0.3
([Engineers Edge](https://ns1.engineersedge.com/mechanics_machines/rolling_resistance_13633.htm),
[Engineers Edge, Marks' data](https://ns1.engineersedge.com/mechanics_machines/coefficients_of_rolling_friction__16286.htm)).
No published grass figure was found; ASSUMED 0.05 to 0.1, inside the soil range.

## 1. Steering torque needed at each kingpin

### 1a. Stationary ("dry park"), wheel free to roll

With the pivot far outside the patch, swinging the corner by dtheta does two things:
1. moves the patch e*dtheta along the tire's rolling direction (e = 111.5 mm): resisted by rolling resistance, `T_roll = Crr * N * e`
2. twists the patch about its own center by dtheta: resisted by patch friction.
   For a circular patch of radius a under uniform pressure, integrating mu*p*r over the disc gives
   `T_spin = (2/3) * mu * N * a` (standard disc friction integral; the general patch integral is in
   [Prakash, Vignati, Sabbioni 2023, arXiv 2303.03018](https://arxiv.org/pdf/2303.03018)).
   Patch size from inflation pressure: `A = N / p`, `a = sqrt(A/pi)`.

| Case | patch radius a | T_spin | T_roll | **Total per corner** |
|---|---|---|---|---|
| L, dirt (mu 0.6, Crr 0.08), 25 psi | 12.8 mm | 0.46 | 0.79 | **1.25 N·m** |
| L, pavement (mu 0.9, Crr 0.02) | 12.8 mm | 0.68 | 0.20 | **0.88 N·m** |
| H, dirt, 25 psi | 19.2 mm | 1.54 | 1.78 | **3.3 N·m** |
| H, pavement | 19.2 mm | 2.31 | 0.45 | **2.8 N·m** |
| H, soft soil or sand (Crr 0.3) | 19.2 mm | 1.5 | 6.7 | **8.2 N·m** |

Using inflation pressure overstates the patch a little (carcass stiffness raises real pressure on small tires), so T_spin is on the high side. Not included: hub motor cogging when unpowered (unknown, likely small) and any drag the ZLAC adds if it brakes the phases (unknown; see 1b).

### 1b. Stationary, wheel HELD (motor holding zero speed, or braking)

If the hub cannot roll, the whole patch has to slide around an arc of radius e:
`T_held = mu * N * e` (pivot far outside patch, so the spin term is small next to it).

| Case | **T_held per corner** |
|---|---|
| L, dirt | **6.0 N·m** |
| L, pavement | **8.9 N·m** |
| H, dirt | **13.4 N·m** |
| H, pavement | **20.1 N·m** |

This is 5 to 7 times the free rolling case. Whether the ZLAC8015D holds the wheel at zero speed command, or lets it
coast when disabled, is not stated in anything found ([ZLAC8015D manual excerpt](https://fabacademy.org/2025/labs/rwanda/students/reginald-itiseng/Final_Project/motor%20driver%20data%20sheets/ZLAC8015D_help.pdf));
servo drives in velocity mode generally hold zero speed actively, and a disabled drive coasts
([Rockwell stopping attributes](https://www.rockwellautomation.com/en-us/docs/studio-5000-logix-designer/38-01/contents-ditamap/instruction-set/cip-axis-attributes/stopping-and-braking-attributes.html)). **Treat "held" as the default until tested.**

### 1c. Rolling (driving)

- Patch twist torque decays quickly once the wheel rolls (arXiv 2303.03018), so self aligning plus twist is well under 1 N·m.
- **Drive torque steer dominates.** Each hub's traction force Fx acts 111.5 mm from its kingpin. Equal forces on both
  front wheels cancel through the tie rod (the tie rod carries them), but any difference reaches the actuator:
  `T_net = e * (Fx_right - Fx_left)`. Upper bound per wheel is mu*N: 0.9 * 200 * 0.1115 = **20 N·m**
  (one wheel gripping, the other spinning or hitting a root). In normal driving with the 4 wheel speeds matched to the
  steering geometry, the difference is small; with mismatched speeds the wheels fight and the actuator feels it.
- Brake or impact on one front wheel: same lever. A 1 kN longitudinal hit gives 112 N·m at that kingpin.

### 1d. Bearing friction (from section 4)

If the bearing insert tilts and the plate rubs on the cast housing, extra friction torque is about `mu_slide * M`
(see 4b). With M = 22 N·m (case H static) and aluminium on cast iron mu 0.3 to 0.5 (ASSUMED handbook range): **6.6 to 11 N·m per corner**.
With a PTFE/UHMW washer (mu 0.05 to 0.15): 1 to 3 N·m. With a needle thrust bearing (mu about 0.005): about 0.1 N·m.

### What the actuator has to beat (both wheels together)

By virtual work the actuator sees `T_eff = T_right + T_left * (dtheta_left/dtheta_right)`; the ratio runs 0.79 to 1.32 across lock (table in 2), so `T_eff` is about 1.8 to 2.3 times the per corner torque.

## 2. Actuator force, lever and speed

Actuator ([Pololu 3645](https://www.pololu.com/product/3645), [LD datasheet](https://www.pololu.com/file/0J1238/LD-Linear-Actuator-Data-Sheet-201208.pdf)):
250 N dynamic, 2500 N static, 27.6 mm/s no load, 23.5 mm/s full load, 25 % duty cycle (1 min on in 4).

Effective lever = rate of actuator length change with steering angle, `dL/dtheta` (mm per radian). Torque available = F * dL/dtheta.
Computed from the exact hole and bracket positions:

| Right plate angle | Left plate | Actuator length | **Lever dL/dtheta** | Torque at 250 N | left/right ratio |
|---|---|---|---|---|---|
| -30 (right turn) | -26.96 | 258.2 | **-9.7 (reversed)** | none, past dead center | 0.79 |
| -25 | -22.91 | 257.8 | **0.7** | 0.2 N·m | 0.83 |
| -20 | -18.67 | 258.3 | 11.0 | 2.8 N·m | 0.87 |
| -10 | -9.67 | 262.0 | 31.0 | 7.8 N·m | 0.93 |
| 0 | 0 | 269.0 | 48.8 | 12.2 N·m | 1.00 |
| +10 | +10.36 | 278.9 | 63.6 | 15.9 N·m | 1.07 |
| +20 | +21.55 | 291.0 | 75.0 | 18.8 N·m | 1.17 |
| +30 (left turn) | +33.92 | 304.8 | 82.8 | 20.7 N·m | 1.32 |

**FINDING (design flaw, easy fix): the actuator goes over dead center at about -25 degrees.**
The hole at (-25, -85) lines up with the actuator's line of push near 25 degrees of right turn, so the
actuator length is a minimum there (257.8 mm) and starts growing again. Consequences:
- Torque available falls to zero near -25; from about -15 on it is below the free rolling need of a loaded robot.
- The same actuator length means two different steering angles, so the pot cannot tell where the wheels are.
- FIT_CHECK's "258 to 305 mm across full lock" is numerically right but missed the reversal.
- The actuator also swings about 15 degrees sideways (heading 49.9 to 34.5 degrees) across lock.

**Recommended fix (plates are not cut yet):** move the actuator hole to **(48, -63)** on the right plate
(back outer corner; inside the existing outline, 8 mm or more from every edge, clear of all other holes)
and slide the bracket along its 110 mm stub to put its pin at **x = -176** in this frame
(54.5 mm toward the robot center from the current spot; frame coordinate -65.5 in the viewer, inside the stub's slide range).
Result, checked over the full +-30:

| | Now | Recommended |
|---|---|---|
| Actuator length over +-30 | 257.8 to 304.8, not monotonic | **258.9 to 337.7, monotonic** (12.9 mm spare closed, 8.3 open) |
| Lever over +-30 | -9.7 to 82.8 mm | **63.5 to 79.2 mm** |
| Torque at 250 N | 0 to 20.7 N·m | **15.9 to 19.8 N·m** |
| Actuator side swing | about 15 degrees | **about 3 degrees** |
| Clearance of actuator line to collar and standoffs | | 22 mm or more at every angle |
| Actuator hits its own end stop at | | -43 / +37 degrees, past the +-30 working range |

(A runner up, (48, -65) with the pin at -181, gives 64.8 to 80.8 mm but only 5 mm spare at full extension.)
The hole stays outside the black plate footprint and its line runs back and inboard, away from the tire.

**Safety factors with the recommended geometry** (torque available / T_eff needed at the worst angle):

| Case | T_eff needed | Available 15.9 to 19.8 N·m | SF |
|---|---|---|---|
| L, free rolling, dirt | about 2.9 N·m | | **5.5 to 6.8** |
| H, free rolling, dirt | about 7.6 N·m | | **2.1 to 2.6** |
| H, free rolling, soft soil | about 19 N·m | | **about 1, marginal** |
| L, wheel held, dirt | about 13.8 N·m | | **1.2 to 1.4, marginal** |
| H, wheel held, pavement | about 46 N·m | | **0.35 to 0.43, will stall** |
| Rolling with matched wheel speeds | under 2 N·m | | **8+** |
| Rolling, one wheel losing grip, H | up to 20 N·m | | **about 1** (actuator may pause, no damage: static rating 2500 N) |

With the current hole, the same table at 0 degrees uses 12.2 N·m and at -20 only 2.8 N·m: it fails the loaded free rolling case past about -15 degrees.

**Speed, recommended geometry:** stroke used 78.8 mm. At 23.5 to 27.6 mm/s: **2.9 to 3.4 s lock to lock**, about 1.5 s center to lock, about 18 degrees per second.
(The current geometry would use only 47 mm of stroke, but it does not work past -25.)

## 3. Ackermann and turning radius

Arm angle: atan(12.5/57.3) = 12.3 degrees outward, tie rod ahead of the axle (front tie rod needs outward arms for Ackermann, so the sign is right).
The textbook rule (arm line through the rear axle center) asks for atan(110.5/457.2) = 13.6 degrees, but that rule is only a small angle approximation and is weaker for a front tie rod.
Exact result from the linkage solve, ideal from `cot(outer) - cot(inner) = 221/457.2`
(the wheel offset is purely along the axle line, so the axle line passes through the kingpin and pivot track 221 is the right T):

| Inner | Outer, linkage | Outer, ideal | Ackermann % |
|---|---|---|---|
| 10 | 9.67 | 9.25 | 44 % |
| 20 | 18.67 | 17.30 | 49 % |
| 30 | 26.96 | 24.54 | 56 % |

**Verdict: partial Ackermann, about 45 to 55 %, between parallel and true Ackermann.** At full lock the outer wheel
is about 2.4 degrees more steered than ideal, a small scrub on a slow robot. Moving the arm holes outward helps a little but
the 200 mm rod only allows about 6.9 to 16.4 mm arm offset (thread engagement 17.5 to 8 mm per heim), so not worth it.

Because the actuator drives the right plate and the left follows through the tie rod, the lock is asymmetric when the right plate is limited to +-30:
- Left turn: right +30, left +33.9 (inner). Turn center 790 mm left of the robot centerline. Outer front wheel path radius 1122 mm, **turning circle about 2.3 m (7.5 ft)** including half the tire width.
- Right turn: right -30 (inner), left -27.0. Turn center 902 mm right of centerline. Outer front wheel 1223 mm, **turning circle about 2.5 m (8.2 ft)**.
- Note from corner-cart.html: past about 19 degrees outboard lock the heim bolt head reaches the bearing flange corner. The left plate goes to 27 degrees outboard on a right turn: check this clearance on the cardboard test.

**Tie rod length error:** toe change = dL / arm lever = 1 mm / 57.3 mm = **1.0 degree of toe per 1 mm** (computed exactly: 1.00 degrees).
Both heims are right hand, so turning the rod does not change the length; adjust by turning one heim: one turn = 1/24 in = 1.06 mm = 1.06 degrees, the smallest practical step (half turn, eye flips) = 0.53 degrees.
Set toe by eye against a straight edge to within half a turn. The pot calibration can absorb an overall offset, but not toe between the two wheels.

## 4. Loads on the parts

Load cases per front corner (H = 200 N static):
- Static: vertical 200 N at 111.5 mm: **M = 22.3 N·m** bending on the pin/plate/bearing about the fore aft axis.
- Bump plus side load (design extreme): 3 g vertical = 600 N at 111.5 mm = 66.9 N·m, plus side force 0.9 * 200 = 180 N at about 195 mm height = 35.1 N·m, summed worst sign: **M = 102 N·m**.
- Steering loads: actuator 250 N dynamic; up to 2500 N if the non-backdrivable actuator holds against an impact.

### 4a. 3/4 in clevis pin
Section modulus Z = pi*d^3/32 = 679 mm^3 (d = 19.05).
- Static: 33 MPa. Extreme: 150 MPa.
- Shear: 600 N / 285 mm^2 = 2 MPa, negligible.
- Material not stated on the Zoro listing beyond "steel"; ASSUMED low carbon, yield 250 to 350 MPa.
**SF about 8 to 10 static, 1.7 to 2.3 at the extreme. Strong enough.** The vertical load goes plate to inner ring face in compression, not through the set screws or the collar; the collar only holds the corner up when the wheel hangs (about 5 to 6 kg).

### 4b. UCF204-12 flange bearing: THE WEAK POINT (not by breaking, by tipping)
Ratings: C = 12.8 kN dynamic, C0 = 6.65 kN static ([Timken UCF204](https://cad.timken.com/item/all-product-types/ucf-four-bolt-flange-units/ucf204?plpver=10), [NTN UCP204-12](https://bearingfinder.ntnamericas.com/pl/item/pillow-block-unit-with-set-screw/ow-block-unit-cast-housing-set-screw-ucp-ucpx-type/ucp204-12)).
Radial and axial loads here are a few hundred N: **SF over 10 on load rating.** The rating is not the issue.

The moment is. A UC insert's outer ring is spherical and sits in a spherical housing bore so it can tilt to self align
([INA/RS housing unit description](https://hken.rs-online.com/web/p/bearing-units/1914544)). Every contact force on a sphere passes through its center,
so **the seat cannot resist a moment by geometry, only by friction**: M_seat about mu * F_radial * R_seat = 0.15 * 180 N * 0.0235 m, about 0.6 N·m,
plus whatever the press fit adds (unknown, varies by maker). The applied moment is 10 N·m (case L) to 22 N·m (case H) static and up to about 100 N·m on bumps.
Expect the insert to tip in its seat until something else touches: the steering plate top against the housing underside.
The gap there depends on which way the insert faces (UCF204 overall width about 33.3 mm with inner ring vs housing about 25.5 mm, so 0 to about 8 mm, catalog style values; caliper it).
Tipping 2 to 10 degrees would camber the wheel, make the plate scrape the cast housing (friction torque about mu*M, 6.6 to 11 N·m per corner loaded, section 1d) and bend the actuator end (section 4e).
The repo's own pivot-sim.html already shows this ("1 bearing ... a hard hit can tip it").

**Fix without changing the design:** put a sliding ring in that gap so the housing carries the moment on purpose:
a needle thrust bearing with two thrust washers (lowest friction, about 0.1 N·m) or a PTFE / UHMW / oil bronze washer (1 to 3 N·m),
inner diameter clearing the inner ring extension, outer diameter inside the 86 mm housing, thickness equal to the measured gap within about 0.2 mm.
The couple is then: inner ring face near the axis plus the ring at 25 to 40 mm radius. The ring force is about M/r = 22.3/0.035 = 640 N static, about 2.9 kN at the extreme, fine for any thrust washer of this size.
Quick bench test before cutting plates: bolt one bearing to a rail, put the pin in, hang 5 kg on a bar 110 mm out; if the pin tips, the ring is required.

### 4c. 1/4 in 6061-T6 steering plate
6061-T6 yield 276 MPa (ASSUMED handbook value).
- Bending from the wheel moment across the section at the pin (net width about 130 mm after the bore and holes): sigma = 6M/(b t^2) = **25 MPa static, 117 MPa extreme, SF 2.4 at the extreme**.
- Actuator hole (6.6 mm, recommended position 8 mm from the edge): bearing stress at 2500 N = 2500/(6.35*6.35) = 62 MPa; shear tear out 2 * 6.35 * 4.7 mm^2 * 165 MPa = about 9.9 kN. **SF about 4 at the actuator's full static load, 40 at its dynamic load.**
- Tie rod arm hole: tie rod force at most about 460 N in steering (19.8 N·m / 43 mm lever at the left plate's worst angle): bearing stress 9 MPa. Negligible.
- Standoffs: the wheel moment crosses to the steering plate through 4 M5 standoffs spaced 41 mm in the outboard direction: 272 N per M5 static, about 1.2 kN extreme, 88 MPa on an A2-70 M5 (yield 450, ASSUMED grade). Fine.

### 4d. Tie rod and heims
- 5/16-24 304 rod, root diameter about 6.6 mm, I = 93 mm^4, E = 193 GPa, pinned ends.
  Euler buckling `P_cr = pi^2 E I / L^2` = **2.9 kN at L = 246, 4.4 kN at L = 200** (heim bodies are stiff, so the truth is in between).
- Tie rod force: normal steering at most about 460 N (SF 6+). Ground friction limit, case H: 20 N·m / 43 to 57 mm = 350 to 465 N (SF 6+). Under a 3 g bump with full grip, about 1.4 kN (SF about 2).
  Only an impact strong enough to make the actuator use its 2500 N static rating (about 1.8 kN longitudinal hit on the left tire) pushes the rod toward buckling, and then the rod bends before anything else in the linkage.
- CF5 heim: ultimate static radial load 3,934 lbf = 17.5 kN ([FK catalog](https://www.fkrodends.com/wp-content/uploads/2023/02/FK-2017-Industrial-Catalog.pdf), [USA Roller Chain](https://usarollerchain.com/products/2783-CF-5-ROD-END)). **SF 35+. Not a concern.**
- Thread engagement 11 mm (1.4 x diameter) per FIT_CHECK: fine.

### 4e. Bolts at the arm and actuator (single shear, so bending is what matters)
Bending in a single shear bolt = F times the distance from the plate mid plane to the joint's mid plane.
- Heim bolt 5/16-18, arm 16.7 mm (half plate + 8 mm spacer + half heim): unclamped bending 85 MPa at 250 N on the shank.
  **Clamp it hard** (nylock torqued; about 7 kN preload, slip resistance about 1.5 kN): the heim ball, spacer and plate then act as one block and the bolt barely bends. The heim ball is meant to be clamped; it swivels in its race.
- Actuator bolt 1/4-20, arm about 9.2 mm (half plate + rod centerline 6 mm below the plate): **91 MPa at 250 N on the shank, 190 MPa if the threads sit in the joint, about 900 MPa at the 2500 N static rating**.
  This joint cannot be clamped tight because the actuator end has to pivot. **This bolt is the weakest steel part in the linkage under an impact.**
  Fix: use a 1/4 in shoulder bolt, or a steel sleeve slightly longer than the actuator lug with a washer, clamped hard so the lug turns on the sleeve; keep the lug tight to the plate (no gap); keep threads out of the shear plane. Shear alone is small (2500 N / 31.7 mm^2 = 79 MPa).
- Actuator bracket: Pololu LA-LD bracket tested to 3100 N static ([Pololu 2314](https://www.pololu.com/product/2314)). Fine.

**Actuator pivot directions (check in hand):** both actuator pivots must turn about a vertical axis so the actuator can swing sideways as the plate turns (3 degrees with the recommended hole, 15 degrees now).
The front end is a vertical 1/4 bolt, good. The LA-LD bracket is a clevis, and a clevis pin normally runs parallel to its base; bolted to the bottom face of the stub (as in steps-4ws step 13), that pin would be horizontal and the actuator could not swing sideways.
Pololu's page does not state the pin direction, and the 3D viewer draws the pin vertical with ears that could not hold it, so confirm with the bracket in hand. If the pin is parallel to the base, bolt the bracket to the **side** face of the 2020 stub so the pin stands vertical.

## 5. Electrical

From the LD datasheet: about 1.2 A no load, 3.2 A at full rated load (250 N), stall about 7 A at 12 V (Pololu).
- Typical steering (free rolling, 3 to 8 N·m): about 40 to 100 N at the rod: **about 1.5 to 2 A** (ASSUMED linear between the no load and full load points).
- Hard steering near the rating: 3.2 A. Stall (end of stroke past the limit switch, jam, held wheels): **7 A**.
- Energy is trivial: 3 A x 12 V x 3 s = about 110 J per lock to lock.
- 12 V supply: the KInuoxj 20 A buck is plenty for one actuator (7 A) and for two in 4WS (14 A worst case both stalled) plus the PIR sensors.
- Fuse: **10 A slow blow per actuator**, matching HARDWARE-INVENTORY's plan; wire 16 AWG (18 AWG is acceptable for 7 A on short runs).
- Pololu Dual G2 18v18: 18 A per channel continuous, so the driver has more than 2x margin over stall.
- Put a 470 to 1000 uF capacitor on the driver's power input: a buck converter cannot absorb current pushed back when the driver brakes or reverses the motor.
- Duty cycle: 25 % (1 min on in 4). A tracking controller that hunts constantly can exceed this; see 6.

## 6. Control physics for the Teensy

**Pot:** 10 kohm class; reads 0 to 600 ohm fully retracted, 8 to 10 kohm fully extended (LD datasheet). Wire ends to 3.3 V and ground, wiper to an analog pin: about 0.2 V to 2.6 to 3.3 V over the stroke.
At 12 bit (Teensy 4.1 supports it; effective about 10 to 11 bits), about 3000 to 3700 counts over 100 mm, so about 0.03 mm per count.
With the recommended geometry (about 1.31 mm of stroke per degree), **about 40 counts per degree**, so the noise floor is about 0.05 to 0.1 degree. At 10 bit: about 10 counts per degree, still fine.
With the current geometry the resolution falls to zero near -25 degrees and the reading is two valued, another reason to move the hole.

**Backdrive:** the actuator "holds its position when unpowered" with a 2500 N static rating, so it is effectively not backdrivable. No holding current is needed; the motor can be off inside the deadband.

**Mapping:** the right plate angle vs actuator length is non linear; store a lookup table (or the closed form from this file) from pot counts to right plate angle, and a second table to the left wheel angle (ratio 0.79 to 1.32). Calibrate center and both ends once, with the wheels off the ground.

**Recommended loop (100 to 200 Hz):**
1. Read the pot with oversampling plus a light low pass (for example 8 samples and a 20 to 30 Hz filter).
2. Rate limit the target: at most about 15 degrees per second, below the actuator's 18 degrees per second, so the loop never saturates during normal moves.
3. P plus a small I with anti windup clamp (I only active within 3 degrees of target), D usually not needed: a lead screw actuator is heavily damped.
4. Deadband: **plus or minus 0.5 degree** (about 20 counts); inside it, PWM = 0 (motor coasts and the screw holds). Add hysteresis (enter at 0.5, leave at 0.8) so it does not chatter.
5. Minimum PWM to break static friction, found on the bench (typically 20 to 30 %).
6. Soft limits at **plus or minus 28 degrees**, 2 degrees inside the mechanical plan, and well inside the actuator's own limit switches (-43 / +37 with the new hole).
7. Current limit from the G2's current sense pin: cut PWM if over 5 A for 200 ms; stall detect if PWM is over 50 % and the pot moves less than 5 counts in 300 ms; then stop and report.
8. Duty cycle budget: track motor on time in a rolling 4 minute window; above 60 s, widen the deadband and slow the target rate.
9. **Coordinate with the ZLAC (the big one):** when steering while stopped, command the two front hubs to roll the arc, `v = omega_steer * 0.1115 m`, right wheel forward and left wheel backward for a left turn (and the reverse), about 35 mm/s at full steering rate. That turns the 6 to 20 N·m held case into the 1 to 3 N·m free case. When driving, set all four wheel speeds from the steering geometry (each wheel's distance to the turn center), so the 111.5 mm scrub radius never turns a speed mismatch into torque steer.

## 7. Rear axle later (4WS)

- **Counter phase (rear opposite to front), slow maneuvering:** the turn center moves to the line midway between the axles. With 30 degrees inner on both axles the turn center is 507 mm from the robot centerline instead of 902 (front only), outer wheel path about 790 mm: **turning circle about 1.6 m (5.2 ft) vs about 2.5 m**, roughly half at the pin and about 0.56x measured at the robot center. The back follows the front's tracks.
- **In phase (both axles the same way), faster driving:** the robot crabs sideways without yawing; useful for lining up on a row or a door.
- **Ackermann shifts:** with the turn center at mid wheelbase the ideal outer angle for a 30 degree inner is 20.3 degrees (`cot o - cot i = 221/228.6`), but the linkage gives about 27 degrees, so in full counter phase the outer wheels over steer about 7 degrees and scrub. Options: run the rear at about 50 to 70 % of the front angle in tight turns, accept the scrub at low speed, or later one actuator per corner for exact angles in every mode.
- **Same actuator dead center problem on the rear:** the rear plate's actuator hole and bracket are the same geometry turned around, so apply the same hole move and bracket slide there.
- Loads per corner are the same; total steering power doubles (two actuators, 14 A worst case both stalled, one 10 A fuse each).
- The rear also has drive torque through a 111.5 mm scrub radius, so the wheel speed coordination in 6.9 matters even more.

## Summary of margins

| Part | Margin | Verdict |
|---|---|---|
| Clevis pin 3/4 | SF 8+ static, about 2 extreme | strong |
| UCF204 load rating | SF 10+ | strong |
| **UCF204 holding the pin upright (moment)** | **seat friction about 0.6 N·m vs 10 to 22 N·m applied** | **will tip; add the sliding ring** |
| Steering plate 6061 | SF 2.4 extreme, 10 static | strong |
| Tie rod buckling | SF 6 normal, about 2 under bump, under 1 only if the actuator holds against a hard hit | adequate |
| CF5 heims | SF 35+ | strong |
| 5/16 heim bolt | fine if clamped hard | fine |
| **1/4-20 actuator bolt** | **fine at 250 N, bends at the actuator's 2500 N static rating** | **use a shoulder bolt or clamped sleeve** |
| **Actuator hole position** | **dead center at about -25 degrees** | **move to (48, -63), slide bracket to -176** |
| Actuator force, free rolling | SF 2.1 to 6.8 | good |
| Actuator force, wheels held | SF 0.35 to 1.4 | let the front wheels roll while steering |
| 12 V buck and 10 A fuse | 7 A stall vs 20 A supply | good |

## Sources
- Pololu 3645 actuator: https://www.pololu.com/product/3645
- Glideforce LD datasheet: https://www.pololu.com/file/0J1238/LD-Linear-Actuator-Data-Sheet-201208.pdf
- Pololu 2314 bracket: https://www.pololu.com/product/2314
- Timken UCF204: https://cad.timken.com/item/all-product-types/ucf-four-bolt-flange-units/ucf204?plpver=10
- NTN UCP204-12: https://bearingfinder.ntnamericas.com/pl/item/pillow-block-unit-with-set-screw/ow-block-unit-cast-housing-set-screw-ucp-ucpx-type/ucp204-12
- Insert bearing spherical seat (RS / INA housing unit): https://hken.rs-online.com/web/p/bearing-units/1914544
- FK rod end catalog (CF5): https://www.fkrodends.com/wp-content/uploads/2023/02/FK-2017-Industrial-Catalog.pdf
- USA Roller Chain CF5: https://usarollerchain.com/products/2783-CF-5-ROD-END
- Contact patch steering moment: https://arxiv.org/pdf/2303.03018
- Tire friction tables: https://hpwizard.com/tire-friction-coefficient.html , https://engineeringtoolbox.com/tractive-effort-d_1783.html
- Rolling resistance: https://ns1.engineersedge.com/mechanics_machines/rolling_resistance_13633.htm , https://ns1.engineersedge.com/mechanics_machines/coefficients_of_rolling_friction__16286.htm
- Drive stop behavior (generic): https://www.rockwellautomation.com/en-us/docs/studio-5000-logix-designer/38-01/contents-ditamap/instruction-set/cip-axis-attributes/stopping-and-braking-attributes.html
- ZLAC8015D manual excerpt: https://fabacademy.org/2025/labs/rwanda/students/reginald-itiseng/Final_Project/motor%20driver%20data%20sheets/ZLAC8015D_help.pdf
