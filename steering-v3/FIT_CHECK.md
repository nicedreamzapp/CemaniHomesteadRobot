> Note 11/18: the bearing part of this check (KFL001, AXK1226, M12 bolt, back spacers) is the earlier 11/15 design. The built design is Fix A (UCF204-12, 3/4 x 2 clevis pin, Ruland collar, 15 mm standoffs); see [PARTS-ORDERED.md](PARTS-ORDERED.md). The actuator fix below is current.

# Front steering fit check (2026-11-15), from the real listings (parts/specs.json)

Fits:
- Eared bearing KFL001: 12 mm bore on the M12 pivot bolt; ear holes 7 mm, 48 mm apart, run along the rail. M5 screws + washers into 2020 T-nuts.
- AXK1226 flat washer bearing: 12 ID / 26 OD / 4 thick, plus two ~1 mm washers, on the M12 bolt.
- M12 x 35 countersunk: head 20.5, the countersink is about 4.3 deep in the 1/4 in plate. Reach: about 10-11 mm into the eared bearing's inner ring. Check it passes the 2 set screws.
- Tie rod: 200 mm rod, heim joints 34.9 from bore center to end, about 248 mm hole to hole, so each end threads about 11 mm into its heim (17.5 max).
- Back spacers: 38.1 long, M5 bore, 10 OD; M5 x 50 leaves about 6 mm into the T-nut under a 6 mm black plate.

Problem found, fixed with the 2020:
- Actuator: 246 mm hole to hole retracted, 346 extended. Mounted on the middle cross rail as drawn before, it would need 228 mm at full lock one way, shorter than it can go, so it could not steer fully that way.
- Fix: put the bracket on a short 2020 piece under the left side rail, about 10 1/4 in behind the front wheel centers (pin 20 mm further back than the first draw, 11/16). Then it needs about 258-305 mm across full lock (+-30 deg), inside 246-346 with about 12 mm spare closed and 41 mm spare open. Same on the back actuator in 4-wheel steering.

Not on the parts list yet (needed to bolt it together):
- 4 M5 x 16 screws + 4 washers + 4 M5 T-nuts: bearing ears to the rail (2 per corner)
- 8 M5 x 25 screws: front black plates to the steering plates (unless the old black plate screws are long enough)
- 2 5/16 bolts about 1 1/4 in + 2 lock nuts: heim joints to the steering arms
- 1 1/4 in bolt about 1 1/4 in + lock nut: actuator front end to the right plate
- 2 M5 x 12 screws + 2 T-nuts: actuator bracket to the short 2020 piece
- 1 L corner bracket + 2 M5 screws + 2 T-nuts: short 2020 piece to the side rail
- 1 short 2020 piece, about 4 in (110 mm)

- 11/18: fix applied. Right plate actuator hole moved to (48, -63) in steer-plate-right-fixA.dxf and the cardboard template; bracket pin goes about 54 mm toward the robot center (x = -176). The 3D corner view shows it.
