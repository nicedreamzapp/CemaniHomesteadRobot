// 4-wheel steering: the front UCF204 corner on all 4 corners, back axle = the front axle turned around (2026-11-16). Sizes in mm. UCF204 numbers are the standard catalog (86 square, 4 holes on a 64 mm
// square, ~12 mm holes, 3/4 in bore); no eBay listing states them, so caliper before the steering plates are cut.
// 2026-11-18: Fix A stack (the parts that were actually ordered, PARTS-ORDERED.md): 3/4 x 2 in clevis pin as the kingpin, steering plate
// squeezed right under the bearing inner ring, Ruland FHT-MCL-12E-F clamp collar under the plate, black plate on 4 x 15 mm standoffs.
// Actuator hole moved to (48,-63) and the bracket pin 54.5 mm toward the middle (PHYSICS.md, corner-cart.html).
window.DIMS={
  // pivot sits midway between the side rail and a 2nd 2020 rail 64 mm inboard; all 4 bearing bolts go straight into T-nuts
  piv:32, inL:70,
  bolt4:[[32,32],[-32,32],[32,-32],[-32,-32]], sqF:86, holeR:6, ear:12, boss:14, ins:7, bossR:28, shaftR:9.525,
  // Ruland face-mount clamp collar: 40 OD x 15 wide, 2 tapped M6 face holes 29.46 apart; 3/4 x 2 in clevis pin, 1-1/8 in head
  colW:15, colR:20, colHole:14.73, pinL:50.8, pinHeadR:14.3, pinHeadT:6.35, std:15,
  plateT:6.35, blackT:6,
  // front: black plate centered 11.5 mm outboard of the pivot, same as the back, so front and back wheels line up
  fbpU:11.5, fslots:[[-9,-32.75],[-9,32.75],[32,-32.75],[32,32.75]],
  // arm hole on the front tab (DXFs), actuator hole on the right plate's back outer corner (11/18)
  arm:[12.5,57.3], acth:[48,-63],
  m5L:18, m5Lf:40,
  heimOD:22.23, heimBore:7.94, heimT:11.1, heimL:34.93, heimShank:12.7, heimBoltL:38.1, heimSpc:8, rodD:7.94,
  // Glideforce LACT4P (Pololu drawing): gearbox 82 x 42, tube 30.5 OD, rod 20 OD, motor 40 OD x 72 beside the tube
  actRet:246, actRear:12, actFront:9, actGearL:52, actMotorL:72, actMotorR:20, actMotorOff:36, actTubeR:15.25, actRod:20, actPin:6.35,
  brkW:38, brkD:39.6, brkEar:7.7, brkPinH:29.2, brkPinL:40.4, brkHoles:20.3,
  // bracket pin: x = -65.5 (11/18, was -120), 10.2 in behind the front axle
  pin:[-65.5,-30], stubL:110,
};
const CL={t:[-110,228.6,-50],r:560,az:2.45,el:-0.35};
const CLc={t:[-110,228.6,-35],r:430,az:2.2,el:-0.45};
const CR={t:[110,228.6,-120],r:900,az:0.75,el:-0.4};
const CF={t:[0,120,-150],r:1350,az:-1.75,el:-0.55};
const CA={t:[-80,-10,-40],r:480,az:-2.3,el:-0.45};
const CB={t:[-122,-228.6,-60],r:520,az:3.6,el:-0.12};
const CS={t:[0,0,-150],r:1700,az:2.6,el:-0.18};
// swing step: from above, 3/4 view, so the counter-steer reads clearly
const CT={t:[0,-30,-150],r:1800,az:-0.4,el:1.05};
window.STEPS=[
 {add:[],cam:CF,t:'The front of your frame, seen from underneath. Each front corner gets a second short 2020 rail so the bearing can bolt straight to the frame with 4 bolts.'},
 {add:['Linrail'],cam:CL,t:'1. Front left: a short <b>2020 rail (110.9 mm)</b> parallel to the side rail, <b>64 mm center to center</b>, with L brackets to the front cross rail and a <b>44 mm cross piece</b>. You have these.'},
 {add:['Ltn_*'],cam:CL,t:'2. <b>4 drop-in M5 T-nuts</b>, 2 in the bottom slot of each rail.'},
 {add:['Lflg'],cam:CL,t:'3. <b>UCF204-12 bearing</b> right under the two rails. Its 4 holes (64 mm apart) line up over the 4 T-nuts.'},
 {add:['Lfb_*'],cam:CLc,t:'4. <b>4 M5 x 18 bolts</b>, each through a <b>sleeve</b> (fills the bearing\'s bigger hole) and a <b>15 mm washer</b>, straight up into the T-nuts.'},
 {add:['Lshaft'],cam:CLc,t:'5. <b>3/4 x 2 in clevis pin</b> (the kingpin) drops down through the bearing from above; its head sits on the inner ring between the rails. Tighten the bearing\'s 2 set screws.'},
 {add:['Lplate'],cam:CLc,t:'6. <b>Steering plate</b> (1/4 in aluminum, laser cut) slides onto the pin right under the bearing.'},
 {add:['Lcol','Lm6_*'],cam:CLc,t:'7. <b>Ruland clamp collar</b> under the plate, pushed up tight and clamped on the pin. <b>2 M6 x 16 flat heads</b> go down through the plate into the collar so the plate can\'t slip.'},
 {add:['Lblack','Lso_*','Lm5_*','Lm5n_*'],cam:CL,t:'8. Your <b>black plate</b> (shock, arm and wheel still on it) hangs on <b>4 standoffs</b> (10 + 5 mm = 15 mm): <b>M5 x 40</b> up from below, washer and nylock on top. Front left done.'},
 {add:['R*'],cam:CR,t:'9. <b>Front right</b>: the same parts in the same order. Only the right plate has the extra hole for the actuator.'},
 {add:['heimL','heimR','tierod'],cam:CF,rcam:{t:[0,170,-45],r:750,az:-1.75,el:0.03},t:'10. <b>Tie rod</b>: a CF5 heim joint threaded onto each end of the 5/16-24 rod, about 246 mm eye to eye.'},
 {add:['hbL','hbR'],cam:CF,rcam:{t:[0,170,-45],r:750,az:-1.75,el:0.03},t:'11. A <b>5/16 x 1-1/2 bolt</b> down through each heim, an <b>8 mm spacer</b> and the arm hole on the front of each plate, nylock underneath. Both front wheels now turn together.'},
 {add:['stub','lbrk','lsA','lsB'],cam:CA,t:'12. <b>Actuator mount</b>: your short 2020 piece (110 mm) under the left side rail, about 10 in behind the front wheels, joined with an L bracket.'},
 {add:['bracket','brkscrew*'],cam:CA,t:'13. <b>Actuator bracket</b> under that piece, about 3 in in from the side rail (moved 2 in toward the middle on 11/18). 2 M5 screws into T-nuts.'},
 {add:['actuator','actpinB','actpinF'],cam:CF,rcam:{t:[0,170,-45],r:750,az:-1.75,el:0.03},t:'14. <b>Actuator</b>: back end on the bracket pin, rod end bolts to the back corner of the right plate (1/4-20 bolt, nylock). It pushes the right wheel; the tie rod moves the left.'},
 {add:['BRinrail'],cam:{t:[110,-228.6,-30],r:480,az:-1.2,el:-0.8},t:'15. <b>Back corners</b> (later, not bought yet): the <b>exact same corner as the front</b>, turned around. Back right first: a short <b>2020 rail</b> 64 mm from the side rail.'},
 {add:['BRtn_*','BRflg','BRfb_*'],cam:{t:[110,-228.6,-30],r:400,az:-1.2,el:-0.8},t:'16. <b>4 T-nuts</b>, the <b>UCF204 bearing</b> under both rails and its <b>4 M5 bolts</b>, same as the front.'},
 {add:['BRshaft','BRplate','BRcol','BRm6_*'],cam:{t:[110,-228.6,-50],r:450,az:-1.2,el:-0.7},t:'17. <b>Clevis pin</b>, <b>steering plate</b> and <b>clamp collar</b>. The arm hole points toward the middle of the robot, where the back tie rod goes.'},
 {add:['BRblack','BRso_*','BRm5_*','BRm5n_*'],cam:{t:[110,-228.6,-140],r:750,az:-1.1,el:-0.35},t:'18. Your <b>black plate</b> and wheel on 4 standoffs. All 4 corners end up the same height.'},
 {add:['BL*'],cam:{t:[-110,-228.6,-150],r:1000,az:-2.0,el:-0.3},t:'19. <b>Back left</b>: the same parts in the same order. This plate gets the hole for the 2nd actuator.'},
 {add:['kheimL','kheimR','ktierod','khbL','khbR'],cam:{t:[0,-200,-60],r:950,az:-1.45,el:-0.9},t:'20. <b>2nd tie rod</b> with a <b>heim joint</b> on each end, bolted to both back steering plates. Now the back wheels turn together.'},
 {add:['kstub','klbrk','klsA','klsB','kbracket','kbrkscrew*'],cam:{t:[120,10,-30],r:520,az:3.0,el:-0.85},t:'21. <b>2nd actuator mount</b>: a short 2020 piece and <b>bracket</b> under the <b>right</b> side rail, ahead of the back wheels. The front one is on the left, so they never touch.'},
 {add:['kactuator','kactpinB','kactpinF'],cam:{t:[0,-120,-100],r:1000,az:-1.45,el:-0.95},t:'22. <b>2nd actuator</b>: back end on its bracket, rod end on the <b>back left steering plate</b>. It steers the back wheels.'},
 {add:[],cam:{t:[0,0,-150],r:1700,az:-0.75,el:-0.38},t:'Built: all 4 corners are the same bearing at the same height, so the robot sits level.'},
 {add:[],cam:CT,swing:true,t:'<b>4-wheel steering</b>: the front wheels turn up to 30°, the back wheels turn the opposite way. <b>4WS turns in about 5.9 ft instead of 8.8 ft.</b>'},
];
// ---- parts per step (2026-11-18). Source: PARTS-ORDERED.md only. st: ord (ordered, confirmation on file) | got (bought) | have (already owned)
// | hold (on hold on purpose) | back (back axle, later, not bought)
(function(){
  const it=(n,size,q,st,o={})=>Object.assign({n,size,q,st},o);
  const BE={ps:'$9.99 each',price:'$9.99 each (eBay)',link:'https://www.ebay.com/itm/170523091215'};
  const ACT={ps:'$194.88',price:'$194.88 (Pololu)',link:'https://www.pololu.com/product/3645'}, BRK={ps:'$24.07',price:'$24.07 (Pololu)',link:'https://www.pololu.com/product/2314'};
  const S=(f,b)=>f==='have'?'have':b?'back':f; // status: front value, or 'back' for the back axle (owned stays owned)
  const rails=(b,p)=>[it('2020 inboard rail','110.9 mm',1,S('have',b),{at:p+'inrail'}),it('2020 cross piece','44 mm',1,S('have',b)),it('2020 L brackets','20 x 20',3,S('have',b))];
  const tn=(b,p)=>[it('M5 drop-in T-nuts for 2020','Amazon B0DMCS8KW4 kit',4,S('got',b),{at:p+'tn_0'})];
  const brg=(b,p)=>[it('UCF204-12 flange bearing','3/4 in bore, eBay 170523091215',1,S('got',b),Object.assign({},BE,{at:p+'flg',lab:'UCF204-12 bearing'}))];
  const fb=(b,p)=>[it('M5 x 18 socket head, stainless','bearing to frame, Amazon B019ETH1CC',4,S('got',b),{at:p+'fb_0',lab:'M5 x 18 + sleeve + washer'}),
    it('Sleeves 12 OD x 5.2 ID x 10','fill the bearing\'s bigger holes, B0BYT4HFFZ',4,S('got',b)),it('M5 washers, 15 mm','B0DDH3QNH4',4,S('got',b))];
  const pin=(b,p)=>[it('Clevis pin 3/4 x 2 in, steel (kingpin)','Zoro G3393796',1,S('ord',b),{at:p+'shaft'})];
  const plate=(b,p,side)=>[it('Steering plate, '+side,'1/4 in 6061 aluminum, 98 x 167 mm, laser cut',1,b?'back':'hold',{at:p+'plate',note:b?'':'on hold until the cardboard template test'})];
  const col=(b,p)=>[it('Ruland FHT-MCL-12E-F clamp collar','3/4 in bore, 40 OD x 15 wide',1,S('ord',b),{at:p+'col',lab:'Ruland clamp collar'}),
    it('M6 x 16 flat head','collar to steering plate, B09Y5PLLGD',2,S('got',b),{at:p+'m6_0'})];
  const black=(b,p)=>[it('Black plate with shock, arm, hub motor','on the robot',1,'have',{at:p+'black',lab:'Black plate + wheel'}),
    it('Standoffs M5, 10 mm + 5 mm stacked = 15 mm','uxcell',4,S('got',b),{at:p+'so_0',lab:'15 mm standoffs'}),
    it('M5 x 40 socket head','B094HQMSQF',4,S('got',b),{at:p+'m5_0'}),it('M5 washers, 15 mm','B0DDH3QNH4',4,S('got',b)),
    it('M5 nylock nuts, stainless','Zoro 50 pack',4,S('ord',b),{at:p+'m5n_0'})];
  const heim=(b,p)=>[it('CF5 heim joints, 5/16-24 RH female','B0C9Y6S5CP',2,S('got',b),{at:p+'heimL'}),
    it('Tie rod 5/16-24 x 200 mm','arrives Nov 30 - Dec 4',1,S('got',b),{at:p+'tierod'})];
  const hb=(b,p)=>[it('5/16 x 1-1/2 bolts + nylocks','heim to plate, B0CJQ3PWF5',2,S('got',b),{at:p+'hbL',lab:'5/16 x 1-1/2 + nylock'}),
    it('Heim spacers 8.2 ID x 16 OD x 8','one under each heim, B0CBJGC6TK',2,S('got',b))];
  const stub=(b,p)=>[it('2020 actuator stub','110 mm',1,S('have',b),{at:p+'stub'}),it('2020 L bracket','20 x 20',1,S('have',b)),it('M5 drop-in T-nuts','2020 slot',2,S('got',b))];
  const bkt=(b,p)=>[it('Glideforce LA-LD bracket (pin included)','Pololu 2314',1,S('ord',b),Object.assign({},BRK,{at:p+'bracket',lab:'LA-LD bracket'})),it('M5 drop-in T-nuts','2020 slot',2,S('got',b))];
  const act=(b,p)=>[it('Glideforce LACT4P-12V-10 actuator','246-346 mm, 4 in stroke, pot feedback',1,S('ord',b),Object.assign({},ACT,{at:p+'actuator',lab:'LACT4P actuator'})),
    it('1/4-20 x 1-1/2 bolt + nylock','rod end to the plate, B081FDPMXS',1,S('got',b),{at:p+'actpinF'})];
  const F=false, K=true;
  const corner=(b,p,side)=>[...rails(b,p),...tn(b,p),...brg(b,p),...fb(b,p),...pin(b,p),...plate(b,p,side),...col(b,p),...black(b,p)];
  window.BUY=[[],rails(F,'L'),tn(F,'L'),brg(F,'L'),fb(F,'L'),pin(F,'L'),plate(F,'L','left'),col(F,'L'),black(F,'L'),
    corner(F,'R','right (actuator hole)'),heim(F,''),hb(F,''),stub(F,''),bkt(F,''),act(F,''),
    rails(K,'BR'),[...tn(K,'BR'),...brg(K,'BR'),...fb(K,'BR')],[...pin(K,'BR'),...plate(K,'BR','back right'),...col(K,'BR')],black(K,'BR'),
    corner(K,'BL','back left (actuator hole)'),[...heim(K,'k'),...hb(K,'k')],[...stub(K,'k'),...bkt(K,'k')],act(K,'k'),[],[]];
  // front parts list = PARTS-ORDERED.md (2026-11-18)
  window.FRONT_LIST={
    groups:[
      {h:'Pololu, ordered 11/18, shipped (order 1J606749)',st:'ord',rows:[['1','Glideforce LACT4P-12V-10 actuator, 4 in stroke, pot feedback, 246-346 mm','Pololu 3645','$194.88'],
        ['1','Glideforce light-duty mounting bracket (back pin, on the stub under the left side rail)','Pololu 2314','$24.07']]},
      {h:'eBay, bought',st:'got',rows:[['2','UCF204-12 flange bearing, 3/4 in bore','eBay 170523091215 (Carnell Sales)','$9.99 each']]},
      {h:'Zoro, ordered 11/18 (order WB5666745153)',st:'ord',rows:[['2','Ruland face-mount clamp collar, 3/4 in bore, 40 OD x 15 wide, 2 tapped M6 face holes','FHT-MCL-12E-F, Zoro G708673879','$25.58'],
        ['2','Clevis pin 3/4 x 2 in, steel (the kingpin)','Zoro G3393796','$9.50'],['1','M5 nylock nuts, stainless, 50 pack','Zoro','$1.99']]},
      {h:'Amazon, bought (14 items)',st:'got',rows:[['20 pk','M5 x 18 socket head, stainless (bearing to frame, 4 per corner)','B019ETH1CC','$9.69'],
        ['1 kit','M5 drop-in T-nuts for 2020','B0DMCS8KW4','$12.99'],['100 pk','M5 washers, 15 mm (fender size)','B0DDH3QNH4','$7.69'],
        ['10 pk','Sleeves 12 OD x 5.2 ID x 10 (fill the bearing\'s bigger bolt holes)','B0BYT4HFFZ','$13.19'],
        ['10 + 20','uxcell standoffs 10 mm + 5 mm, M5 (stacked = 15 mm, 4 per corner)','2 listings','$11.78'],
        ['1 pk','M5 x 40 socket head (black plate + standoff + steering plate)','B094HQMSQF','$9.99'],
        ['20 pk','M6 x 16 flat head (collar to steering plate, 2 per corner)','B09Y5PLLGD','$7.99'],
        ['2','CF5 heim joints, 5/16 bore, 5/16-24 RH female, jam nuts','B0C9Y6S5CP','$9.99'],
        ['1','Tie rod 5/16-24 x 7.9 in (200 mm), arrives Nov 30 - Dec 4','','$7.89'],
        ['5 pk','Heim spacers 8.2 ID x 16 OD x 8 (one under each heim)','B0CBJGC6TK','$9.99'],
        ['1 kit','5/16 x 1-1/2 bolts + nylocks (heim joints to the steering plates)','B0CJQ3PWF5','$21.99'],
        ['10 sets','1/4-20 x 1-1/2 bolts + nylocks (actuator rod end to the right plate)','B081FDPMXS','$6.99'],
        ['1','Fgruh M5 screw assortment (spare, optional)','','$9.99']]},
      {h:'Steering plates: on hold',st:'hold',rows:[['1 + 1','Steering plates, 1/4 in 6061 aluminum, 98 x 167 mm, laser cut; the right one has the actuator hole','DXF fixA','not quoted']],
        note:'On hold until the cardboard template test.'}],
    have:['2020 extrusion: 2 inboard rails (110.9 mm), 2 cross pieces (44 mm), 1 actuator stub (110 mm)','2020 L brackets',
      'The 2 front black plates with their shocks and hub motor wheels (on the robot)','Power and control electronics on the robot; the Teensy 4.1 runs the actuator from its pot'],
    total:'Pololu $218.95 + eBay $19.98 + Zoro about $37.07 + Amazon $140.16 = about $416 before tax, plates not included.'};
})();
