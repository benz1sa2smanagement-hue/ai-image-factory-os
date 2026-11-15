(() => {
'use strict';
const canvas=document.querySelector('#filmCanvas'),stage=document.querySelector('#stage');
const loading=document.querySelector('#loading'),loadText=document.querySelector('#loadText');
const track=document.querySelector('#thumbTrack'),lightbox=document.querySelector('#lightbox');
const imageEl=document.querySelector('#lightboxImage'),titleEl=document.querySelector('#lightboxTitle'),countEl=document.querySelector('#lightboxCount');
const images=window.NIRIN_IMAGES || (typeof NIRIN_IMAGES !== 'undefined' ? NIRIN_IMAGES : []);
let modal=-1, chosen=-1,spin=!matchMedia('(prefers-reduced-motion:reduce)').matches;
let yaw=-0.28,tilt=-0.11,zoom=1,yawVel=0,lastUserMove=-10000;
let dragging=false,dragX=0,dragY=0,startX=0,startY=0,dragDistance=0,pinchLength=0;
let lastTime=performance.now();const pointers=new Map();
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
images.forEach((item,i)=>{
 const btn=document.createElement('button');btn.type='button';btn.className='thumb';btn.setAttribute('role','listitem');btn.title=item.title;
 const im=document.createElement('img');im.src=item.src;im.alt=item.title;im.loading='lazy';btn.appendChild(im);
 const num=document.createElement('small');num.textContent=item.id;btn.appendChild(num);
 btn.addEventListener('click',()=>openModal(i));track.appendChild(btn);
});
document.querySelector('#counter').textContent=`${images.length} IMAGES · 2 SIDES`;
function selectThumb(i){chosen=i;[...track.children].forEach((el,j)=>el.classList.toggle('selected',i===j));track.children[i]?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});}
function openModal(i){if(!images.length)return;modal=(i+images.length)%images.length;selectThumb(modal);imageEl.src=images[modal].src;imageEl.alt=images[modal].title;titleEl.textContent=images[modal].title;countEl.textContent=`${String(modal+1).padStart(2,'0')} / ${String(images.length).padStart(2,'0')}`;lightbox.hidden=false;document.body.style.overflow='hidden';document.querySelector('#lightboxClose').focus();}
function closeModal(){modal=-1;lightbox.hidden=true;document.body.style.overflow='';}
document.querySelector('#galleryBtn').onclick=()=>openModal(0);
document.querySelector('#lightboxClose').onclick=closeModal;
document.querySelector('#lightboxOverlay').onclick=closeModal;
document.querySelector('#prevImage').onclick=()=>openModal(modal-1);
document.querySelector('#nextImage').onclick=()=>openModal(modal+1);
window.addEventListener('keydown',e=>{if(modal!==-1){if(e.key==='Escape')closeModal();if(e.key==='ArrowRight')openModal(modal+1);if(e.key==='ArrowLeft')openModal(modal-1);return;}if(e.key==='ArrowRight')yaw+=.25;if(e.key==='ArrowLeft')yaw-=.25;});
const spinBtn=document.querySelector('#autospin');
spinBtn.onclick=()=>{spin=!spin;spinBtn.classList.toggle('active',!spin);spinBtn.textContent=spin?'Ⅱ':'▶';spinBtn.title=spin?'หยุดหมุนอัตโนมัติ':'เริ่มหมุนอัตโนมัติ';};
document.querySelector('#zoomIn').onclick=()=>zoom=clamp(zoom+.12,.75,1.9);
document.querySelector('#zoomOut').onclick=()=>zoom=clamp(zoom-.12,.75,1.9);
document.querySelector('#reset').onclick=()=>{yaw=-.28;tilt=-.11;zoom=1;yawVel=0;};

// One physically continuous, perforated film strip; only 1.7 revolutions. Both sides are printed.
const R=1.62,TURNS=1.72,PITCH=1.12,BAND=.78,TMAX=2*Math.PI*TURNS;
const FRAMES=16,INTERVAL=TMAX/FRAMES;
const frontImages=Array.from({length:FRAMES},(_,i)=>i%images.length);
const backImages=Array.from({length:FRAMES},(_,i)=>(FRAMES-1-i+6+images.length)%images.length);

function fallback(){
 // Graceful canvas fallback used on devices without WebGL2. Curved slices approximate the real geometry.
 const ctx=canvas.getContext('2d');if(!ctx){loading.textContent='เลือกภาพจากแกลเลอรีด้านล่าง';return;}
 let last=performance.now(),hit=[];const photos=images.map(item=>{const im=new Image();im.src=item.src;return im;});
 function project(t,v,r){const x=r*Math.cos(t),y=PITCH*(t-TMAX/2)/(2*Math.PI)+v,z=r*Math.sin(t),c=Math.cos(yaw),s=Math.sin(yaw),xx=c*x+s*z,zz=-s*x+c*z,ct=Math.cos(tilt),st=Math.sin(tilt),yy=ct*y-st*zz,depth=st*y+ct*zz;const f=canvas.height/(2*Math.tan((stage.clientWidth<700?45:36)*Math.PI/360)),d=(stage.clientWidth<700?8.2:8.6)/zoom;return{x:canvas.width/2+f*xx/(d-depth),y:canvas.height/2-f*yy/(d-depth),depth};}
 function quad(t,u,v0,v1,r){return[project(t,v1,r),project(u,v1,r),project(u,v0,r),project(t,v0,r)];}
 function path(q){ctx.beginPath();ctx.moveTo(q[0].x,q[0].y);for(let i=1;i<4;i++)ctx.lineTo(q[i].x,q[i].y);ctx.closePath();}
 function inside(x,y,q){let ok=false;for(let i=0,j=3;i<4;j=i++){if((q[i].y>y)!=(q[j].y>y)&&x<(q[j].x-q[i].x)*(y-q[i].y)/(q[j].y-q[i].y)+q[i].x)ok=!ok;}return ok;}
 function draw(){const dpr=Math.min(devicePixelRatio||1,1.5);const w=Math.floor(canvas.clientWidth*dpr),h=Math.floor(canvas.clientHeight*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
 ctx.clearRect(0,0,w,h);hit=[];let segments=[];
 for(let i=0;i<FRAMES;i++){let a=i*INTERVAL+.025,b=(i+1)*INTERVAL-.025;for(let j=0;j<14;j++){let t=a+(b-a)*j/14,u=a+(b-a)*(j+1)/14,q=quad(t,u,-BAND/2,BAND/2,R);segments.push({i,j,t,u,q,z:(q[0].depth+q[1].depth)/2,insideFacing:Math.sin((t+u)/2-yaw)<0});}}
 segments.sort((a,b)=>a.z-b.z);
 for(const s of segments){path(s.q);ctx.fillStyle='#dad6d5';ctx.fill();
 const p=quad(s.t,s.u,-.32,.32,R+.008);path(p);ctx.fillStyle='#faf9f7';ctx.fill();
 const idx=s.insideFacing?backImages[s.i]:frontImages[s.i],im=photos[idx];if(im?.complete&&im.naturalWidth){const a=p[0],b=p[1],d=p[3],src=im.naturalWidth/14;ctx.save();path(p);ctx.clip();ctx.setTransform((b.x-a.x)/src,(b.y-a.y)/src,(d.x-a.x)/im.naturalHeight,(d.y-a.y)/im.naturalHeight,a.x,a.y);ctx.drawImage(im,src*s.j,0,src,im.naturalHeight,0,0,src+.8,im.naturalHeight);ctx.restore();}
 hit.push({p,idx});
 for(let v of [-.35,.35]){path(quad(s.t+.011,s.u-.011,v-.016,v+.016,R+.012));ctx.fillStyle='#fff';ctx.fill();}
 }
 }
 function frame(t){const dt=Math.min(.05,(t-last)/1000);last=t;if(!dragging){yaw+=yawVel*dt;yawVel*=Math.pow(.045,dt);if(spin&&t-lastUserMove>1000&&modal===-1)yaw+=dt*.20;}draw();requestAnimationFrame(frame)}
 loading.classList.add('loaded');requestAnimationFrame(frame);
 canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===1){dragging=true;startX=dragX=e.clientX;startY=dragY=e.clientY;dragDistance=0;yawVel=0;}lastUserMove=performance.now();});
 canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size>1)return;const dx=e.clientX-dragX,dy=e.clientY-dragY;yaw+=dx*.009;tilt=clamp(tilt+dy*.004,-.4,.35);yawVel=dx*.17;dragX=e.clientX;dragY=e.clientY;dragDistance=Math.max(dragDistance,Math.hypot(e.clientX-startX,e.clientY-startY));lastUserMove=performance.now();});
 const up=e=>{if(!pointers.has(e.pointerId))return;pointers.delete(e.pointerId);if(!pointers.size){dragging=false;if(dragDistance<9){const rect=canvas.getBoundingClientRect(),x=(e.clientX-rect.left)*canvas.width/rect.width,y=(e.clientY-rect.top)*canvas.height/rect.height;for(let j=hit.length-1;j>=0;j--)if(inside(x,y,hit[j].p)){openModal(hit[j].idx);break;}}}};
 canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=clamp(zoom-e.deltaY*.0009,.75,1.9);lastUserMove=performance.now()},{passive:false});
}
let gl=null;
try{gl=canvas.getContext('webgl2',{alpha:true,antialias:true,depth:true,premultipliedAlpha:true,preserveDrawingBuffer:false,powerPreference:'high-performance'});}catch(e){}
if(!gl){fallback();return;}

const vertexSrc=`#version 300 es
precision highp float;
in vec3 aPos;in vec2 aUv;in vec3 aNormal;
uniform float uYaw,uTilt,uFocal,uAspect,uDistance;
out vec2 vUv;out float vShade;out float vFacing;out float vSpec;
void main(){
 float c=cos(uYaw),s=sin(uYaw);
 vec3 p=vec3(c*aPos.x+s*aPos.z,aPos.y,-s*aPos.x+c*aPos.z);
 vec3 n=vec3(c*aNormal.x+s*aNormal.z,aNormal.y,-s*aNormal.x+c*aNormal.z);
 float ct=cos(uTilt),st=sin(uTilt);
 p=vec3(p.x,ct*p.y-st*p.z,st*p.y+ct*p.z);
 n=normalize(vec3(n.x,ct*n.y-st*n.z,st*n.y+ct*n.z));
 float depth=uDistance-p.z,near=.1,far=80.;
 gl_Position=vec4(uFocal*p.x/uAspect,uFocal*p.y,depth*(far+near)/(far-near)-2.*far*near/(far-near),depth);
 vUv=aUv;
 vec3 viewDir=normalize(vec3(-p.x,-p.y,depth));
 vFacing=dot(n,viewDir);
 vec3 light=normalize(vec3(-.52,.8,1.1));
 vShade=.80+.20*max(0.,dot(n,light));
 vSpec=pow(max(0.,dot(reflect(-light,n),viewDir)),24.);
}`;
const fragSrc=`#version 300 es
precision highp float;
in vec2 vUv;in float vShade;in float vFacing;in float vSpec;
uniform sampler2D uImage;uniform int uMode;uniform vec4 uTint;uniform vec3 uPick;
out vec4 outColor;
void main(){
 if(uMode==0||uMode==2){if(vFacing<.015)discard;}
 if(uMode==2){outColor=vec4(uPick,1.);return;}
 if(uMode==1){outColor=vec4(min(vec3(1.),uTint.rgb*vShade+vec3(.18*vSpec)),uTint.a);return;}
 vec4 texel=texture(uImage,vUv);
 outColor=vec4(texel.rgb*(.90+.10*vShade)+vec3(.035*vSpec),texel.a);
}`;
function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
let program;
try{program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertexSrc));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragSrc));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));}catch(e){console.warn(e);loading.textContent='เปิดแกลเลอรีด้านล่างเพื่อดูภาพ';loading.classList.add('loaded');return;}
gl.useProgram(program);
const loc={yaw:gl.getUniformLocation(program,'uYaw'),tilt:gl.getUniformLocation(program,'uTilt'),focal:gl.getUniformLocation(program,'uFocal'),aspect:gl.getUniformLocation(program,'uAspect'),distance:gl.getUniformLocation(program,'uDistance'),mode:gl.getUniformLocation(program,'uMode'),tint:gl.getUniformLocation(program,'uTint'),pick:gl.getUniformLocation(program,'uPick')};
const attr={pos:gl.getAttribLocation(program,'aPos'),uv:gl.getAttribLocation(program,'aUv'),normal:gl.getAttribLocation(program,'aNormal')};
gl.uniform1i(gl.getUniformLocation(program,'uImage'),0);
gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
const meshes=[],textures=[];
function point(t,v,r){return [r*Math.cos(t),PITCH*(t-TMAX/2)/(2*Math.PI)+v,r*Math.sin(t)];}
function patch(t0,t1,v0,v1,r,segments=5,sign=1,flipU=false){
 const out=[];
 function vert(t,v,u,vt){const p=point(t,v,r),n=sign;out.push(p[0],p[1],p[2],flipU?1-u:u,vt,Math.cos(t)*n,0,Math.sin(t)*n);}
 for(let j=0;j<segments;j++){const a=t0+(t1-t0)*j/segments,b=t0+(t1-t0)*(j+1)/segments,ua=j/segments,ub=(j+1)/segments;
 vert(a,v0,ua,0);vert(b,v0,ub,0);vert(a,v1,ua,1);
 vert(a,v1,ua,1);vert(b,v0,ub,0);vert(b,v1,ub,1);}
 return out;
}
function mesh(data,mode,color,index=-1,texSlot=-1){
 if(!data.length)return;
 const vbo=gl.createBuffer(),vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
 for(const [name,size,offset] of [['pos',3,0],['uv',2,12],['normal',3,20]]){gl.enableVertexAttribArray(attr[name]);gl.vertexAttribPointer(attr[name],size,gl.FLOAT,false,32,offset);}
 gl.bindVertexArray(null);meshes.push({vao,count:data.length/8,mode,color,index,texSlot});
}
// The non-image region is physical film stock, with actual open sprocket holes cut into its rails.
const silver=[.937,.927,.918,1],edge=[.91,.90,.897,1],divider=[.78,.767,.762,1];
mesh(patch(0,TMAX,-.355,.355,R,230),1,silver);
for(const s of [-1,1]){
 let v=(a,b)=>s===1?[a,b]:[-b,-a];
 let r=v(.355,.388);mesh(patch(0,TMAX,r[0],r[1],R,230),1,edge);
 r=v(.455,.487);mesh(patch(0,TMAX,r[0],r[1],R,230),1,edge);
 let holes=[];const spacing=.146,hole=.076;
 for(let t=.025;t<TMAX-.016;t+=spacing){const a=t+hole,b=Math.min(t+spacing,TMAX);if(b>a){const range=v(.388,.455);holes.push(...patch(a,b,range[0],range[1],R,2));}}
 mesh(holes,1,edge);
}
let dividers=[];
for(let i=1;i<FRAMES;i++){const t=i*INTERVAL;dividers.push(...patch(t-.014,t+.014,-.355,.355,R+.006,2));}
mesh(dividers,1,divider);
// Film emulsion is coated on BOTH surfaces. Geometry follows the spiral on both sides;
// inward-facing textures reverse U so lettering stays legible rather than mirrored.
for(let i=0;i<FRAMES;i++){
 const a=i*INTERVAL+.032,b=(i+1)*INTERVAL-.032;
 mesh(patch(a,b,-.322,.322,R+.014,13,+1,false),0,[1,1,1,1],frontImages[i],frontImages[i]);
 mesh(patch(a,b,-.322,.322,R-.014,13,-1,true),0,[1,1,1,1],backImages[i],backImages[i]);
}
function makeTexture(img){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.generateMipmap(gl.TEXTURE_2D);return t;}
let loaded=0;images.forEach((it,i)=>{const im=new Image();im.onload=()=>{try{textures[i]=makeTexture(im);}catch(e){console.warn(e)}loaded++;loadText.textContent=`กำลังเตรียมภาพ ${loaded}/${images.length}`;if(loaded===images.length)loading.classList.add('loaded');};im.onerror=()=>{loaded++;if(loaded===images.length)loading.classList.add('loaded');};im.src=it.src;});
function resize(){const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.7),w=Math.max(1,Math.floor(r.width*dpr)),h=Math.max(1,Math.floor(r.height*dpr));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);}}
const observer=new ResizeObserver(resize);observer.observe(canvas);window.addEventListener('resize',resize);resize();
function uniforms(){const fov=(stage.clientWidth<700?45:37)*Math.PI/180,distance=(stage.clientWidth<700?8.2:8.6)/zoom;gl.uniform1f(loc.yaw,yaw);gl.uniform1f(loc.tilt,tilt);gl.uniform1f(loc.focal,1/Math.tan(fov/2));gl.uniform1f(loc.aspect,canvas.width/canvas.height);gl.uniform1f(loc.distance,distance);}
function render(pick=false){gl.useProgram(program);resize();if(pick){gl.disable(gl.BLEND);gl.clearColor(0,0,0,1)}else{gl.enable(gl.BLEND);gl.clearColor(0,0,0,0);}gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);uniforms();
 for(const m of meshes){if(pick&&m.index<0)continue;if(!pick&&m.mode===0&&!textures[m.texSlot])continue;
 gl.bindVertexArray(m.vao);gl.uniform1i(loc.mode,pick?2:m.mode);
 if(pick)gl.uniform3f(loc.pick,(m.index+1)/255,0,0);
 else if(m.mode===0){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[m.texSlot]);}
 else gl.uniform4fv(loc.tint,m.color);
 gl.drawArrays(gl.TRIANGLES,0,m.count);
 }
 gl.bindVertexArray(null);
}
function imageAt(x,y){render(true);const rect=canvas.getBoundingClientRect(),sx=Math.floor((x-rect.left)*canvas.width/rect.width),sy=Math.floor((rect.bottom-y)*canvas.height/rect.height);if(sx<0||sy<0||sx>=canvas.width||sy>=canvas.height)return -1;const px=new Uint8Array(4);gl.readPixels(sx,sy,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);return px[0]?px[0]-1:-1;}
function tick(now){const dt=Math.min(.05,(now-lastTime)/1000||.016);lastTime=now;if(!dragging&&!pointers.size){yaw+=yawVel*dt;yawVel*=Math.pow(.04,dt);if(Math.abs(yawVel)<.0002)yawVel=0;if(spin&&modal===-1&&now-lastUserMove>1200)yaw+=dt*.20;}render(false);requestAnimationFrame(tick)}requestAnimationFrame(tick);
canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===1){dragging=true;startX=dragX=e.clientX;startY=dragY=e.clientY;dragDistance=0;yawVel=0;canvas.classList.add('dragging');}if(pointers.size===2)pinchLength=pinch();lastUserMove=performance.now();});
function pinch(){const p=[...pointers.values()];return Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);}
canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size>=2){const len=pinch();if(pinchLength>0)zoom=clamp(zoom*len/pinchLength,.75,1.9);pinchLength=len;lastUserMove=performance.now();return;}const dx=e.clientX-dragX,dy=e.clientY-dragY;yaw+=dx*.0085;tilt=clamp(tilt+dy*.0038,-.4,.35);yawVel=dx*.19;dragX=e.clientX;dragY=e.clientY;dragDistance=Math.max(dragDistance,Math.hypot(e.clientX-startX,e.clientY-startY));lastUserMove=performance.now();});
function pointerUp(e){if(!pointers.has(e.pointerId))return;pointers.delete(e.pointerId);if(!pointers.size){dragging=false;canvas.classList.remove('dragging');if(dragDistance<9){const idx=imageAt(e.clientX,e.clientY);if(idx>=0)openModal(idx);}}else if(pointers.size===1){const p=[...pointers.values()][0];dragX=p.x;dragY=p.y;dragDistance=999;}lastUserMove=performance.now();}
canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=clamp(zoom-e.deltaY*.0008,.75,1.9);lastUserMove=performance.now();},{passive:false});
window.addEventListener('webglcontextlost',e=>{e.preventDefault();loading.textContent='การ์ดจอหยุดทำงาน กรุณารีเฟรชหน้าเว็บ';loading.classList.remove('loaded');});
})();