// Sizes in mm. FIT notes say where each number comes from (listing / catalog standard / your photos / model).
window.DIMS={
  // KFL001 eared bearing (listing: bore 12, holes 7, 48 apart, overall 63 x 38 x 16)
  earC:48, earL:63, earW:38, earT:8, earHole:7, earBolt:5, earBoltL:16, earWasher:20, brgH:16, brgOD:32, bore:12,
  // AXK1226 (listing: 12 / 26 / 4) + two ~1 mm washers (catalog)
  thrOD:26, thrH:6,
  nutH:12, plateT:6.35, blackT:6, pivotL:35, bpU:-12,
  slots:[[-32.5,-32.75],[-32.5,32.75],[8.5,-32.75],[8.5,32.75]], arm:[-17.8,-57.3], acth:[-25,-85],
  m5L:50, m5Lf:25,
  // CF5 heim (listing): bore 7.938, head 22.23, ball width 11.1, bore center to end 34.93, shank 12.7
  heimOD:22.23, heimBore:7.94, heimT:11.1, heimL:34.93, heimShank:12.7, heimBoltL:32, rodD:7.94,
  // Glideforce LACT4P-12V-10 (Pololu drawing): 246 retracted hole to hole, 100 stroke, tube 30.5, motor 40
  actRet:246, actRear:12, actFront:9, actMotorL:110, actMotorR:20, actTubeR:15.25, actRod:12, actPin:6.35,
  // bracket (datasheet): base 38 x 39.6, pin 29.2 high, ears 7.7, 2 holes 7
  brkW:38, brkD:39.6, brkEar:7.7, brkPinH:29.2, brkPinL:40.4, brkHoles:20.3,
  pin:[-120,-10], stubL:110,
  spacerL:38.1, spacerOD:10,
};
const CL={t:[-138,228.6,-22],r:300,az:2.45,el:-0.42};
const CLc={t:[-142.5,228.6,-25],r:230,az:2.2,el:-0.5};
const CR={t:[142.5,228.6,-25],r:380,az:0.75,el:-0.45};
const CF={t:[-10,100,-40],r:820,az:-1.75,el:-0.6};
const CA={t:[-115,-10,-25],r:300,az:-2.3,el:-0.45};
const CB={t:[-135,-228.6,-25],r:300,az:-2.4,el:-0.4};
window.STEPS=[
 {add:[],cam:CF,t:'The front of your frame, seen from underneath. Each front corner gets a steering pivot between the rail and your black plate.'},
 {add:['Ltnut*'],cam:CL,t:'1. Front left: slide 2 T-nuts into the bottom slot of the side rail, one for each ear of the bearing.'},
 {add:['Lbrg'],cam:CL,t:'2. Eared bearing (KFL001) up against the bottom of the rail, ear holes over the T-nuts.'},
 {add:['Learbolt*'],cam:CL,t:'3. 2 bolts with washers up through the ears into the T-nuts. Tighten.'},
 {add:['Lthr'],cam:CLc,t:'4. Flat washer bearing (AXK1226: washer, needle cage, washer) under the eared bearing.'},
 {add:['Lplate','Lpivot','Lnut'],cam:CLc,t:'5. New steering plate: M12 x 35 countersunk bolt up through its center hole, M12 lock nut on top, tight. Push the bolt up through the flat washer bearing into the eared bearing and tighten its 2 set screws.'},
 {add:['Lblack'],cam:CL,t:'6. Your black plate (with the shock, arm and wheel still on it) goes under the steering plate.'},
 {add:['Lm5_*'],cam:CL,t:'7. 4 M5 x 25 screws up through the black plate and the 4 slots in the steering plate. The slots cover the hole spacing range from your tape photos.'},
 {add:['Lm5n_*'],cam:CL,t:'8. A big fender washer and an M5 lock nut on each screw, on top of the plate. Front left done.'},
 {add:['R*'],cam:CR,t:'9. Front right: the same parts in the same order. Only the right plate has the extra hole for the actuator.'},
 {add:['heimL','heimR','tierod'],cam:CF,t:'10. Tie rod: thread a heim joint onto each end of the 5/16-24 rod.'},
 {add:['hbL','hbR'],cam:CF,t:'11. A 5/16 bolt down through each heim joint into the arm hole on each plate, lock nut underneath. Now both wheels turn together.'},
 {add:['stub','lbrk','lsA','lsB'],cam:CA,t:'12. A short piece of your 2020 (about 4 in) hangs under the left side rail, about 9½ in behind the front wheels, joined with an L corner bracket: one M5 screw into a T-nut in each piece.'},
 {add:['bracket','brkscrew*'],cam:CA,t:'13. Actuator bracket under that piece: 2 M5 screws into T-nuts. Slide it in the slot to fine-tune.'},
 {add:['actuator','actpinB','actpinF'],cam:CF,t:'14. Actuator: back end on the bracket pin (R-clip), front end bolts up into the right plate with a 1/4 in bolt and lock nut. It pushes and pulls the right plate; the tie rod moves the left.'},
 {add:['Bblack'],cam:CB,t:'15. Back corners: the black plate is there today. Take its 4 screws out.'},
 {add:['Bsp*','Btn*'],cam:CB,t:'16. A 1½ in aluminum spacer at each of the 4 holes, between the rail and the black plate. That lifts the back the same 1½ in as the front stack.'},
 {add:['Bscr*'],cam:CB,t:'17. 4 M5 x 50 screws up through the black plate and the spacers into the T-nuts. Same on the other back corner. Done.'},
 {add:[],cam:CF,t:'Done: steering on the front, the back raised to match, the robot sits level.'},
];
