'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('class Vec3'));

function fixture() {
  const nodes = {};
  const context = vm.createContext({
    document: {
      getElementById: id => nodes[id] ??= {
        textContent: '', innerHTML: '', addEventListener() {},
        classList: { add() {}, remove() {} }
      },
      addEventListener() {}
    },
    window: { addEventListener() {} }, console: { log() {} },
    requestAnimationFrame() {}
  });
  vm.runInContext(source, context);
  return { context, nodes, run: expression => vm.runInContext(expression, context) };
}

const plain = value => JSON.parse(JSON.stringify(value));
const vertex = (x, y, z) => ({ x, y, z });
const nearZ = -.4;
function close(actual, expected, epsilon = 1e-11) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}
function clipped(f, vertices) {
  f.context.vertices = vertices;
  return plain(f.run('clipTriangleNearPlane(vertices)'));
}

test('inside identity, outside rejection and exact on-plane endpoints', () => {
  const f = fixture();
  assert.equal(f.run(`(()=>{const a=[new Vec3(-1,0,-.4),new Vec3(1,0,-2),new Vec3(0,1,-3)];return clipTriangleNearPlane(a)===a;})()`), true);
  assert.deepEqual(clipped(f, [vertex(-1,0,-.3),vertex(1,0,0),vertex(0,1,2)]), []);
  for (const vertices of [
    [vertex(-1,0,nearZ),vertex(1,0,1),vertex(0,1,2)],
    [vertex(-1,0,nearZ),vertex(1,0,nearZ),vertex(0,1,2)],
    [vertex(-1,0,-1),vertex(1,0,nearZ),vertex(0,1,2)]
  ]) {
    const polygon = clipped(f, vertices);
    assert.equal(new Set(polygon.map(v => `${v.x},${v.y},${v.z}`)).size, polygon.length);
    assert.ok(polygon.every(v => v.z <= nearZ));
  }
});

test('known one/two-inside intersections preserve winding for every permutation', () => {
  const f = fixture();
  for (const zs of [[-1.4,.6,.6],[-1.4,-1.4,.6]]) {
    const original = [vertex(-2,-1,zs[0]),vertex(2,-1,zs[1]),vertex(0,3,zs[2])];
    const expected = zs[1] > nearZ
      ? [[-2,-1,-1.4],[0,-1,nearZ],[-1,1,nearZ]]
      : [[-2,-1,-1.4],[2,-1,-1.4],[1,1,nearZ],[-1,1,nearZ]];
    for (const permutation of [[0,1,2],[1,2,0],[2,0,1],[2,1,0],[1,0,2],[0,2,1]]) {
      const input = permutation.map(i => original[i]);
      const polygon = clipped(f, input);
      assert.equal(polygon.length, expected.length);
      for (const v of polygon) assert.ok(expected.some(e => Math.hypot(v.x-e[0],v.y-e[1],v.z-e[2]) < 1e-12));
      const signedArea = vertices => vertices.reduce((sum,v,i) => {
        const next=vertices[(i+1)%vertices.length]; return sum+v.x*next.y-v.y*next.x;
      }, 0);
      assert.equal(Math.sign(signedArea(polygon)), Math.sign(signedArea(input)));
    }
  }
});

test('shared edges produce identical intersections in both directions', () => {
  const f = fixture();
  for (let i=1;i<=500;i++) {
    const a=vertex(Math.sin(i)*3,Math.cos(i)*2,-.4-i/37);
    const b=vertex(Math.cos(i*3)*4,Math.sin(i*2)*5,-.4+i/83);
    const c=vertex(20,30,-10), d=vertex(-20,-30,-10);
    const p=clipped(f,[a,b,c]), q=clipped(f,[b,a,d]);
    const t=(-.4-a.z)/(b.z-a.z), x=a.x+t*(b.x-a.x), y=a.y+t*(b.y-a.y);
    const cutP=p.find(v=>v.z===nearZ&&v.x===x&&v.y===y);
    const cutQ=q.find(v=>v.z===nearZ&&v.x===x&&v.y===y);
    assert.ok(cutP&&cutQ); assert.deepEqual(cutP,cutQ);
  }
});

// Independent ray/triangle intersection oracle: no polygon clipping or fan.
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function hit(ray, triangle) {
  const [a,b,c]=triangle.map(v=>[v.x,v.y,v.z]), e1=sub(b,a), e2=sub(c,a);
  const h=cross(ray,e2), determinant=dot(e1,h);
  if(Math.abs(determinant)<1e-12)return null;
  const s=a.map(v=>-v), u=dot(s,h)/determinant, q=cross(s,e1), v=dot(ray,q)/determinant;
  const depth=dot(e2,q)/determinant;
  return {u,v,depth,inside:u>=0&&v>=0&&u+v<=1};
}

function raster(f, triangles) {
  f.context.triangles=triangles;
  return plain(f.run(`(()=>{
    for(let y=0;y<SCREEN_HEIGHT;y++)for(let x=0;x<SCREEN_WIDTH;x++){zBuffer[y][x]=FAR_PLANE;screenBuffer[y][x]=' ';}
    const projection=Mat4.makeProjection(FOV_RADIANS,ASPECT_RATIO,NEAR_PLANE,FAR_PLANE);
    for(const [index,triangle] of triangles.entries()){
      const polygon=clipTriangleNearPlane(triangle.map(v=>new Vec3(v.x,v.y,v.z))).map(v=>Mat4.multiplyVec(projection,v)).map(v=>({x:(v.x/v.w+1)*.5*SCREEN_WIDTH,y:(1-(v.y/v.w+1)*.5)*SCREEN_HEIGHT,w:1/v.w}));
      for(let i=1;i+1<polygon.length;i++)drawTriangle(polygon[0],polygon[i],polygon[i+1],String(index));
    }
    return {depths:zBuffer,characters:screenBuffer};
  })()`));
}

test('clipped raster matches analytic ray depths through near/eye/behind-camera crossings', () => {
  const f=fixture(), focal=1/Math.tan((Math.PI/2.5)/2), aspect=1.2;
  let covered=0, empty=0;
  for(const depths of [[-1,-2,-3],[-.2,-2,-1],[.9,-2,-1],[2,1,-2],[1,2,3],[-.4,-2,-1],[-.4,-.4,1],[-.399,-.401,-2]]) {
    const triangle=[vertex(-1.2,-.8,depths[0]),vertex(1.5,-.7,depths[1]),vertex(.1,1.4,depths[2])];
    const result=raster(f,[triangle]);
    for(let y=0;y<60;y++)for(let x=0;x<120;x++){
      const ray=[(2*(x+.5)/120-1)/(aspect*focal),(1-2*(y+.5)/60)/focal,-1];
      const expected=hit(ray,triangle);
      // Rasterizer's existing edge tolerance can include mathematical boundaries.
      if(expected && (Math.min(Math.abs(expected.u),Math.abs(expected.v),Math.abs(expected.u+expected.v-1))<1e-8 || Math.abs(expected.depth-.4)<1e-9))continue;
      if(expected?.inside && expected.depth>=.4 && expected.depth<100){
        close(result.depths[y][x],expected.depth,1e-9); covered++;
      }else{assert.equal(result.depths[y][x],100);empty++;}
    }
  }
  assert.ok(covered>1000&&empty>1000);
});

test('overlapping clipped geometry keeps order-independent depth and no fan seam', () => {
  const f=fixture();
  const triangles=[
    [vertex(-2,-2,-2),vertex(2,-2,-2),vertex(0,2,-2)],
    [vertex(-1,-1,-1),vertex(1,-1,-1),vertex(0,2,.6)]
  ];
  const front=raster(f,triangles),back=raster(f,triangles.toReversed());
  for(let y=0;y<60;y++)for(let x=0;x<120;x++)close(front.depths[y][x],back.depths[y][x]);
});

test('legal close-wall turning sequence yields finite near-clipped depths', () => {
  const f=fixture();
  f.run('camera.pos=new Vec3(-12.4,0,-12.4);');
  assert.equal(f.run('[[PLAYER_RADIUS,0],[-PLAYER_RADIUS,0],[0,PLAYER_RADIUS],[0,-PLAYER_RADIUS]].every(([x,z])=>!isWallAtWorldPos(camera.pos.x+x,camera.pos.z+z))'),true);
  for(let i=0;i<72;i++){
    f.run(`camera.yaw=${i*Math.PI/36};camera.pitch=${Math.sin(i/6)*.6};renderFrame(0);`);
    assert.equal(f.run('zBuffer.every(row=>row.every(z=>Number.isFinite(z)&&z>=NEAR_PLANE&&z<=FAR_PLANE))'),true);
    assert.equal(f.nodes.gameScreen.textContent.split('\n').length,60);
    assert.ok(f.nodes.gameScreen.textContent.split('\n').every(row=>row.length===120));
  }
});
