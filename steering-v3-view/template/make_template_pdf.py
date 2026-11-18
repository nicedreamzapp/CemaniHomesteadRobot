# Full-size cardboard test template for the Fix A steering plates, straight to PDF (mm units, exact scale).
import ezdxf, os
from fpdf import FPDF
HERE=os.path.dirname(os.path.abspath(__file__)); PL=os.path.join(HERE,'..','plates')
NAME={19.65:'shaft bore',6.6:'M6 countersunk',8.2:'8.2 mm hole',8.0:'bolt hole'}
def load(n):
    d=ezdxf.readfile(os.path.join(PL,n)); L=[];C=[]
    for e in d.modelspace():
        if e.dxftype()=='LINE': L.append(((e.dxf.start.x,e.dxf.start.y),(e.dxf.end.x,e.dxf.end.y)))
        elif e.dxftype()=='CIRCLE': C.append((e.dxf.center.x,e.dxf.center.y,2*e.dxf.radius))
    return L,C
pdf=FPDF(unit='mm',format='letter'); pdf.set_auto_page_break(False)
W=215.9
for title,fn,sx in [('RIGHT steering plate','steer-plate-right-fixA.dxf',-42.0),('LEFT steering plate','steer-plate-left-fixA.dxf',42.0)]:
    L,C=load(fn); xs=[p[0] for l in L for p in l]; ys=[p[1] for l in L for p in l]
    minx,maxx,miny,maxy=min(xs),max(xs),min(ys),max(ys)
    ox=(W-(maxx-minx))/2-minx; oy=26+maxy; X=lambda x:x+ox; Y=lambda y:oy-y
    pdf.add_page(); pdf.set_font('Helvetica','B',13); pdf.set_xy(10,7); pdf.cell(0,6,f'{title} - FULL SIZE. Print at 100% / Actual Size (no "fit to page").')
    pdf.set_font('Helvetica','',9); pdf.set_xy(10,13); pdf.multi_cell(196,4.2,'Top view. Glue to cardboard, cut on the black line, poke a hole at each red + center. First check BOTH scale bars below with a ruler; if either is off, the print is scaled wrong.')
    pdf.set_draw_color(0,0,0); pdf.set_line_width(0.35)
    for a,b in L: pdf.line(X(a[0]),Y(a[1]),X(b[0]),Y(b[1]))
    rows=[]
    for i,(cx,cy,d) in enumerate(sorted(C,key=lambda c:(-c[1],c[0])),1):
        px,py=X(cx),Y(cy); r=d/2
        pdf.set_draw_color(31,95,179); pdf.set_line_width(0.25); pdf.ellipse(px-r,py-r,d,d)
        k=r+1.5; pdf.set_draw_color(210,0,0); pdf.set_line_width(0.15); pdf.line(px-k,py,px+k,py); pdf.line(px,py-k,px,py+k)
        pdf.set_text_color(210,0,0); pdf.set_font('Helvetica','B',9); pdf.text(px+r+0.8,py-r-0.3,str(i)); pdf.set_text_color(0,0,0)
        rows.append((i,d,'actuator hole' if abs(cy+85)<0.1 else NAME.get(round(d,2),''),abs(cx-sx),cy-miny))
    by=Y(miny)+14; pdf.set_draw_color(0,0,0); pdf.set_line_width(0.3); pdf.set_font('Helvetica','',8.5)
    for x0,ln,lab in [(10,100,'must measure exactly 100 mm'),(125,76.2,'must measure exactly 3 in')]:
        pdf.line(x0,by,x0+ln,by); pdf.line(x0,by-2,x0,by+2); pdf.line(x0+ln,by-2,x0+ln,by+2); pdf.text(x0,by-3,lab)
    side='left' if sx<0 else 'right'; ty=by+9
    pdf.set_font('Helvetica','B',9.5); pdf.text(10,ty,f'Hole check (mm, measured to hole CENTERS from the long straight {side} edge and the bottom edge)')
    pdf.set_font('Courier','B',9); pdf.text(10,ty+5,f'#   size     what             from {side:<5}  from bottom  ok?')
    pdf.set_font('Courier','',9)
    for j,(i,d,n,ex,ey) in enumerate(rows): pdf.text(10,ty+10+j*4.4,f'{i:<3} {d:<7.2f}  {n:<16} {ex:>8.2f}  {ey:>10.2f}    ____')
    yb=ty+10+len(rows)*4.4+2; pdf.set_font('Helvetica','',8.5)
    pdf.text(10,yb,f'4 bolt holes: 41.0 mm apart side to side, 65.5 mm front to back. M6 pair: 29.46 mm apart. Plate {maxx-minx:.0f} x {maxy-miny:.0f} mm.')
    pdf.text(10,yb+4.5,'Cardboard test: holes line up with the bearing, bracket and frame bolts? Steering swings full left/right without hitting anything?')
out=os.path.join(HERE,'steering-plate-template.pdf'); pdf.output(out); print(out)
