// 4-wheel steering: the front UCF204 corner on all 4 corners, back axle = the front axle turned around (2026-11-16). Sizes in mm. UCF204 numbers are the standard catalog (86 square, 4 holes on a 64 mm
// square, ~12 mm holes, 3/4 in bore); no eBay listing states them, so caliper before the steering plates are cut.
window.DIMS={
  // pivot sits midway between the side rail and a 2nd 2020 rail 64 mm inboard; all 4 bearing bolts go straight into T-nuts
  piv:32, inL:70,
  bolt4:[[32,32],[-32,32],[32,-32],[-32,-32]], sqF:86, holeR:6, ear:12, boss:14, ins:7, bossR:28, shaftR:9.525,
  // 3/4 in bore flanged shaft collar under the bearing: carries the wheel load up into the bearing, flange bolts to the steering plate
  colH:16, colFlR:22,
  plateT:6.35, blackT:6,
  // front: black plate centered 20.5 mm inboard of the side rail, same as the back, so front and back wheels line up
  fbpU:11.5, fslots:[[-9,-32.75],[-9,32.75],[32,-32.75],[32,32.75]],
  arm:[-17.8,-57.3], acth:[-25,-85],
  m5L:70, m5Lf:25,
  heimOD:22.23, heimBore:7.94, heimT:11.1, heimL:34.93, heimShank:12.7, heimBoltL:32, rodD:7.94,
  actRet:246, actRear:12, actFront:9, actMotorL:110, actMotorR:20, actTubeR:15.25, actRod:12, actPin:6.35,
  brkW:38, brkD:39.6, brkEar:7.7, brkPinH:29.2, brkPinL:40.4, brkHoles:20.3,
  pin:[-120,-30], stubL:110,
};
const CL={t:[-110,228.6,-50],r:560,az:2.45,el:-0.35};
const CLc={t:[-110,228.6,-35],r:430,az:2.2,el:-0.45};
const CR={t:[110,228.6,-120],r:900,az:0.75,el:-0.4};
const CF={t:[0,120,-150],r:1350,az:-1.75,el:-0.55};
const CA={t:[-115,-10,-40],r:480,az:-2.3,el:-0.45};
const CB={t:[-122,-228.6,-60],r:520,az:3.6,el:-0.12};
const CS={t:[0,0,-150],r:1700,az:2.6,el:-0.18};
// swing step: from above, 3/4 view, so the counter-steer reads clearly
const CT={t:[0,-30,-150],r:1800,az:-0.4,el:1.05};
window.STEPS=[
 {add:[],cam:CF,t:'The front of your frame, seen from underneath. Each front corner gets a second short 2020 rail so the bearing can bolt straight to the frame with 4 bolts.'},
 {add:['Linrail'],cam:CL,t:'1. Front left: a short piece of 2020 (about 4½ in) parallel to the side rail, <b>64 mm center to center</b>, with L brackets to the front cross rail and a short cross piece.'},
 {add:['Ltn_*'],cam:CL,t:'2. <b>4 drop-in M6 T-nuts</b>, 2 in the bottom slot of each rail.'},
 {add:['Lflg'],cam:CL,t:'3. <b>UCF204 bearing</b> right under the two rails. Its 4 holes (64 mm apart) line up over the 4 T-nuts.'},
 {add:['Lfb_*'],cam:CLc,t:'4. <b>4 M6 bolts</b> with step sleeves (they fill the bearing\'s bigger holes) and washers, straight up into the T-nuts. All 4 bolts go into the frame.'},
 {add:['Lshaft'],cam:CLc,t:'5. <b>¾ in shaft</b> (bought cut to length) pushes up into the bearing, into the gap between the rails. Tighten the bearing\'s 2 set screws.'},
 {add:['Lcol'],cam:CLc,t:'6. <b>Flanged collar</b> under the bearing, clamped on the shaft. The wheel pushes up: this collar carries that into the bearing.'},
 {add:['Lplate'],cam:CLc,t:'7. <b>Steering plate</b> (laser cut) bolts to the collar flange so it can\'t slip. Your black plate sits on it exactly where it sits at the back, so the wheels line up.'},
 {add:['Lblack','Lm5_*','Lm5n_*'],cam:CL,t:'8. Your <b>black plate</b> (shock, arm and wheel still on it) bolts under the steering plate with 4 M5 screws, washers and lock nuts. Front left done.'},
 {add:['R*'],cam:CR,t:'9. <b>Front right</b>: the same parts in the same order. Only the right plate has the extra hole for the actuator.'},
 {add:['heimL','heimR','tierod'],cam:CF,t:'10. <b>Tie rod</b>: a heim joint threaded onto each end of the 5/16-24 rod.'},
 {add:['hbL','hbR'],cam:CF,t:'11. A <b>5/16 bolt</b> down through each heim joint into the arm hole on each steering plate, lock nut underneath. Now both front wheels turn together.'},
 {add:['stub','lbrk','lsA','lsB'],cam:CA,t:'12. <b>Actuator mount on the frame</b>: a short piece of your 2020 (about 4 in) under the left side rail, about 10¼ in behind the front wheels, joined with an L bracket.'},
 {add:['bracket','brkscrew*'],cam:CA,t:'13. <b>Actuator bracket</b> under that piece: 2 M5 screws into T-nuts. Slide it in the slot to fine-tune.'},
 {add:['actuator','actpinB','actpinF'],cam:CF,t:'14. <b>Actuator</b>: back end on the bracket pin, front end bolts to the right steering plate (¼ in bolt, lock nut). It pushes and pulls the right wheel; the tie rod moves the left.'},
 {add:['BRinrail'],cam:{t:[110,-228.6,-30],r:480,az:-1.2,el:-0.8},t:'15. <b>Back corners</b>: now they get the <b>exact same corner as the front</b>, just turned around. Back right first: a short <b>2020 rail</b> 64 mm center to center from the side rail, L brackets to the back cross rail.'},
 {add:['BRtn_*','BRflg','BRfb_*'],cam:{t:[110,-228.6,-30],r:400,az:-1.2,el:-0.8},t:'16. <b>4 T-nuts</b>, the <b>UCF204 bearing</b> under both rails and its <b>4 M6 bolts</b>, same as the front.'},
 {add:['BRshaft','BRcol','BRplate'],cam:{t:[110,-228.6,-50],r:450,az:-1.2,el:-0.7},t:'17. <b>¾ in shaft</b>, <b>flanged collar</b> and <b>steering plate</b>. The arm hole points toward the middle of the robot, where the back tie rod goes.'},
 {add:['BRblack','BRm5_*','BRm5n_*'],cam:{t:[110,-228.6,-140],r:750,az:-1.1,el:-0.35},t:'18. Your <b>black plate</b> and wheel bolt on with 4 M5 screws. <b>No spacers needed now</b>: all 4 corners are the same height.'},
 {add:['BL*'],cam:{t:[-110,-228.6,-150],r:1000,az:-2.0,el:-0.3},t:'19. <b>Back left</b>: the same parts in the same order. This plate gets the hole for the 2nd actuator.'},
 {add:['kheimL','kheimR','ktierod','khbL','khbR'],cam:{t:[0,-200,-60],r:950,az:-1.45,el:-0.9},t:'20. <b>2nd tie rod</b> with a <b>heim joint</b> on each end, bolted to both back steering plates. Now the back wheels turn together.'},
 {add:['kstub','klbrk','klsA','klsB','kbracket','kbrkscrew*'],cam:{t:[120,10,-30],r:520,az:3.0,el:-0.85},t:'21. <b>2nd actuator mount</b>: a short 2020 piece and <b>bracket</b> under the <b>right</b> side rail, about 10¼ in ahead of the back wheels. The front one is on the left, so they never touch.'},
 {add:['kactuator','kactpinB','kactpinF'],cam:{t:[0,-120,-100],r:1000,az:-1.45,el:-0.95},t:'22. <b>2nd actuator</b>: back end on its bracket, front end on the <b>back left steering plate</b>. It steers the back wheels.'},
 {add:[],cam:{t:[0,0,-150],r:1700,az:-0.75,el:-0.38},t:'Built: all 4 corners are the same bearing at the same height, so the robot sits level.'},
 {add:[],cam:CT,swing:true,t:'<b>4-wheel steering</b>: the front wheels turn up to 30°, the back wheels turn the opposite way. <b>4WS turns in about 5.9 ft instead of 8.8 ft.</b>'},
];
// ---- buy list per step (2026-11-16). Source: PARTS-FRONT.md (front, buy order) + PARTS-4WS.md (back). Prices/links only where a real
// listing was read; everything else is "size confirmed after bearings are measured". st: have | buy | back (= back, later)
(function(){
  const SZ='size confirmed after bearings are measured';
  const EB={ps:'2-pack $19.98',price:'$19.98 per 2-pack, free ship',link:'https://www.ebay.com/itm/170523091215'};
  const ACT={ps:'$194.88',price:'$194.88',link:'https://www.pololu.com/product/3645'}, BRK={ps:'$24.07',price:'$24.07',link:'https://www.pololu.com/product/2314'};
  const it=(n,size,q,st,o={})=>Object.assign({n,size,q,st},o);
  const rails=(st,p)=>[it('2020 inboard rail','~4.5 in (115 mm)',1,st,{note:SZ,at:p+'inrail'}),it('2020 cross piece','108 mm',1,st,{note:SZ}),it('2020 L brackets','20 x 20',3,st,{note:SZ}),
    it('M5 x 10 screws (L brackets)','M5 x 10',6,st,{note:SZ}),it('M5 drop-in T-nuts','M5, 2020 slot',6,st,{note:SZ})];
  const tn=(st,p)=>[it('M6 drop-in T-nuts','M6, 2020 slot',4,st,{note:SZ,at:p+'tn_0'})];
  const brg=(st,p,extra)=>[it('UCF204-12 flange bearing',"3/4 in bore, 86 mm square, 64 mm bolt square (caliper on arrival)",1,st,Object.assign({},EB,{at:p+'flg',lab:'UCF204-12 bearing'},extra||{}))];
  const fb=(st,p)=>[it('M6 x 30 bolts','M6 x 30',4,st,{note:SZ,at:p+'fb_0',lab:'M6 x 30 bolts + washers + step sleeves'}),it('M6 flat washers','M6',4,st,{note:SZ}),it('Step sleeves','12 OD / 6.4 ID / 12 long',4,st,{note:SZ})];
  const shaft=(st,p)=>[it('3/4 in steel shaft, pre-cut','3/4 in x ~2 in',1,st,{note:SZ,at:p+'shaft'})];
  const col=(st,p)=>[it('3/4 in flanged shaft collar','3/4 in bore',1,st,{note:SZ,at:p+'col'})];
  const plate=(st,p,side)=>[it('Steering plate, laser cut ('+side+')','1/4 in (6.35 mm), ~3 1/8 x 5 3/4 in',1,st,{note:SZ,at:p+'plate'})];
  const black=(st,p)=>[it('Black plate with shock, arm, hub motor','on the robot',1,'have',{at:p+'black',lab:'Black plate + wheel'}),it('M5 x 25 screws (black plate)','M5 x 25, SS',4,st,{note:SZ,at:p+'m5_0'}),
    it('M5 fender washers','20 mm OD',4,'have',{note:'pack, enough'}),it('M5 nylon lock nuts','M5',4,'have',{note:'pack, enough'})];
  const heim=(st,p,have)=>[it('Heim joints CF5 5/16-24 RH female','5/16 x 5/16-24',2,have?'have':st,have?{at:p+'heimL'}:{link:'https://www.amazon.com/dp/B0C9Y6S5CP',note:'1 more 2-pack, price not verified',at:p+'heimL'}),
    it('Tie rod, 5/16-24 threaded rod','5/16-24 x 200 mm',1,'have',{note:have?'':'2-pack covers both axles',at:p+'tierod'})];
  const hb=(st,p)=>[it('5/16 bolts (heim joints)','5/16 x 1-1/4 in',2,st,{note:SZ,at:p+'hbL',lab:'5/16 x 1-1/4 bolts + nylocks'}),it('5/16 nylon lock nuts','5/16',2,st,{note:SZ})];
  const stub=(st,p)=>[it('2020 actuator stub','110 mm',1,st,{note:SZ,at:p+'stub'}),it('2020 L bracket','20 x 20',1,st,{note:SZ}),it('M5 x 10 screws','M5 x 10',2,st,{note:SZ}),it('M5 drop-in T-nuts','M5, 2020 slot',2,st,{note:SZ})];
  const bkt=(st,p,have)=>[it('Glideforce LA-LD bracket (pin included)','38 x 39.6 mm base',1,have?'have':st,Object.assign({},BRK,{at:p+'bracket',lab:'LA-LD bracket'+(have?'':' (2nd)')})),
    it('M5 x 12 screws (bracket)','M5 x 12',2,st,{note:SZ}),it('M5 drop-in T-nuts','M5, 2020 slot',2,st,{note:SZ})];
  const act=(st,p,have)=>[it('Glideforce LACT4P-12V-10 actuator','246-346 mm, 4 in stroke, feedback',1,have?'have':st,Object.assign({},ACT,{at:p+'actuator',lab:'LACT4P actuator'+(have?'':' (2nd)')})),
    it('1/4 in bolt (actuator front)','1/4 x 1-1/4 in',1,st,{note:SZ,at:p+'actpinF'}),it('1/4 in nylon lock nut','1/4',1,st,{note:SZ})];
  const B='buy', K='back';
  window.BUY=[[],rails(B,'L'),tn(B,'L'),brg(B,'L',{note:'1 of the 2-pack'}),fb(B,'L'),shaft(B,'L'),col(B,'L'),plate(B,'L','left'),black(B,'L'),
    [...rails(B,'R'),...tn(B,'R'),...brg(B,'R',{note:'2nd of the same 2-pack'}),...fb(B,'R'),...shaft(B,'R'),...col(B,'R'),...plate(B,'R','right, actuator hole'),...black(B,'R')],
    heim(B,'',true),hb(B,''),stub(B,''),bkt(B,'',true),act(B,'',true),
    rails(K,'BR'),[...tn(K,'BR'),...brg(K,'BR',{note:'2nd 2-pack'}),...fb(K,'BR')],[...shaft(K,'BR'),...col(K,'BR'),...plate(K,'BR','back right')],black(K,'BR'),
    [...rails(K,'BL'),...tn(K,'BL'),...brg(K,'BL',{note:'2nd of the 2nd 2-pack'}),...fb(K,'BL'),...shaft(K,'BL'),...col(K,'BL'),...plate(K,'BL','back left, actuator hole'),...black(K,'BL')],
    [...heim(K,'k',false),...hb(K,'k')],[...stub(K,'k'),...bkt(K,'k',false)],act(K,'k',false),[],[]];
  // full front list in buy order (PARTS-FRONT.md)
  window.FRONT_LIST={have:[['2','Black plates with shock, arm, hub motor','on the robot'],['2 + 1','Heim joints CF5 5/16-24 + tie rod 5/16-24 x 200 mm','bought for the old design, carry over'],
      ['1 + 1','Glideforce LACT4P actuator 246-346 mm + LA-LD bracket with pin','Pololu 3645 / 2314'],['packs','M5 fender washers + M5 nylocks','enough']],
    buy:[['1','2 (one 2-pack)','UCF204-12 bearings, 3/4 in bore','caliper the 4 bolt holes on arrival (plan: 64 mm square)',EB.price,EB.link],
      ['2','2','Flanged collar under each bearing, 3/4 in bore',SZ,'',''],['3','2','3/4 in steel shaft, pre-cut ~2 in',SZ,'',''],
      ['4','2','Steering plates, 1/4 in, laser cut (right one has the actuator hole)','cut after 1-3 are measured','',''],
      ['5','5','2020 extrusion: 2 inboard rails ~4.5 in (115 mm), 2 cross pieces 108 mm, 1 actuator stub 110 mm',SZ,'',''],['6','7','2020 L brackets',SZ,'',''],
      ['7a','8 + 8 + 8 + 8','M6 x 30 bolts, M6 washers, M6 drop-in T-nuts, step sleeves 12 OD / 6.4 ID / 12 long (bearings)',SZ,'',''],
      ['7b','16','M5 drop-in T-nuts',SZ,'',''],['7c','14','M5 x 10 screws (L brackets)',SZ,'',''],['7d','2','M5 x 12 screws (actuator bracket)',SZ,'',''],
      ['7e','8','M5 x 25 screws (black plates)',SZ,'',''],['7f','2 + 2','5/16 x 1-1/4 bolts + 5/16 nylocks (heim joints)',SZ,'',''],['7g','1 + 1','1/4 x 1-1/4 bolt + 1/4 nylock (actuator front end)',SZ,'','']],
    total:'$19.98 (bearings); everything else unpriced until measured'};
})();
