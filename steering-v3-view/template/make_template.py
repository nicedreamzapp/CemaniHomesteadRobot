# Full-size paper/cardboard drill template for the Fix A steering plates.
import ezdxf, math, sys, os
HERE=os.path.dirname(os.path.abspath(__file__)); PL=os.path.join(HERE,'..','plates')
def load(n):
    d=ezdxf.readfile(os.path.join(PL,n)); L=[];C=[]
    for e in d.modelspace():
        if e.dxftype()=='LINE': L.append(((e.dxf.start.x,e.dxf.start.y),(e.dxf.end.x,e.dxf.end.y)))
        elif e.dxftype()=='CIRCLE': C.append((e.dxf.center.x,e.dxf.center.y,2*e.dxf.radius))
    return L,C
NAME={19.65:'shaft bore',6.6:'M6 countersunk',8.2:'8.2 hole',8.0:'bolt hole'}
def page(title,fn,straight_x):
    L,C=load(fn)
    xs=[p[0] for l in L for p in l]; ys=[p[1] for l in L for p in l]
    minx,maxx,miny,maxy=min(xs),max(xs),min(ys),max(ys)
    W,H=215.9,279.4; ox=(W-(maxx-minx))/2-minx; oy=22+maxy   # page coords: X=x+ox, Y=oy-y
    X=lambda x:x+ox; Y=lambda y:oy-y
    s=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}mm" height="{H}mm" viewBox="0 0 {W} {H}" font-family="Helvetica">']
    s.append(f'<text x="10" y="10" font-size="5" font-weight="bold">{title} — FULL SIZE, print at 100% / Actual Size</text>')
    s.append('<text x="10" y="16" font-size="3.4">Top view. Glue to cardboard, cut on the black line, poke each + center. Check both scale bars first.</text>')
    for (a,b) in L: s.append(f'<line x1="{X(a[0]):.2f}" y1="{Y(a[1]):.2f}" x2="{X(b[0]):.2f}" y2="{Y(b[1]):.2f}" stroke="#000" stroke-width="0.35"/>')
    rows=[]
    for i,(cx,cy,d) in enumerate(sorted(C,key=lambda c:(-c[1],c[0])),1):
        px,py=X(cx),Y(cy)
        s.append(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="{d/2:.3f}" fill="none" stroke="#1f5fb3" stroke-width="0.25"/>')
        k=d/2+1.5
        s.append(f'<path d="M{px-k:.2f} {py:.2f}H{px+k:.2f}M{px:.2f} {py-k:.2f}V{py+k:.2f}" stroke="#d00" stroke-width="0.15"/>')
        s.append(f'<text x="{px+d/2+1:.2f}" y="{py-d/2-0.5:.2f}" font-size="3.2" font-weight="bold" fill="#d00">{i}</text>')
        rows.append((i,d,NAME.get(round(d,2),''),abs(cx-straight_x),cy-miny))
    # scale bars
    by=Y(miny)+14
    s.append(f'<path d="M10 {by}h100M10 {by-2}v4M110 {by-2}v4" stroke="#000" stroke-width="0.3"/><text x="10" y="{by-3}" font-size="3.2">must measure exactly 100 mm</text>')
    s.append(f'<path d="M120 {by}h101.6M120 {by-2}v4M221.6 {by-2}v4" stroke="#000" stroke-width="0.3" transform="translate(-30 0) scale(1)"/>' if False else
             f'<path d="M120 {by}h76.2M120 {by-2}v4M196.2 {by-2}v4" stroke="#000" stroke-width="0.3"/><text x="120" y="{by-3}" font-size="3.2">must measure exactly 3 in</text>')
    side='left' if straight_x<0 else 'right'
    ty=by+9
    s.append(f'<text x="10" y="{ty}" font-size="3.4" font-weight="bold">Caliper check (mm, hole centers). Edges: the long straight {side} side, and the bottom edge.</text>')
    s.append(f'<text x="10" y="{ty+5}" font-size="3.2">#   hole size   what              from {side} side   from bottom    ok (±0.3)</text>')
    for j,(i,d,n,ex,ey) in enumerate(rows):
        s.append(f'<text x="10" y="{ty+10+j*4.6:.1f}" font-size="3.2" xml:space="preserve">{i:<3} Ø{d:<9.2f} {n:<17} {ex:>7.2f}          {ey:>7.2f}        ____</text>')
    yb=ty+10+len(rows)*4.6+2
    s.append(f'<text x="10" y="{yb:.1f}" font-size="3.2">4 bolt holes: 41.00 mm apart side to side, 65.50 mm front to back. M6 pair: 29.46 mm apart. Plate: {maxx-minx:.0f} x {maxy-miny:.0f} mm.</text>')
    s.append('</svg>')
    return ''.join(s)
html=['<html><head><style>@page{size:letter;margin:0}body{margin:0}svg{display:block;page-break-after:always}</style></head><body>']
html.append(page('RIGHT steering plate','steer-plate-right-fixA.dxf',56.0))
html.append(page('LEFT steering plate','steer-plate-left-fixA.dxf',-56.0))
html.append('</body></html>')
open(os.path.join(HERE,'steering-plate-template.html'),'w').write(''.join(html))
