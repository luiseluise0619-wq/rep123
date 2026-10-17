const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),{decodePlusCode,coreAddress}=require('../scripts/apply-map-coordinate-review.cjs');
test('Plus Code decoding follows the published WGS84 example and preserves eleven-digit cell precision',()=>{
 const p=decodePlusCode('8FVC9G8F+6W');assert.equal(p.latitude,47.3655625);assert.equal(p.longitude,8.5248125);
 const q=decodePlusCode('8Q996462+QR7');assert.equal(q.latitude,37.2119125);assert.equal(q.longitude,127.10204687);assert.ok(Math.abs(q.cellLatitudeDegrees-.000025)<1e-12);
 assert.throws(()=>decodePlusCode('6462+QR'));assert.throws(()=>decodePlusCode('8Q996462+INVALID'));
});
test('address identity cannot silently swap lot suffixes or mountain parcels',()=>{
 assert.notEqual(coreAddress('서울특별시 금천구 가산동 549-9'),coreAddress('서울특별시 금천구 가산동 549-1'));
 assert.notEqual(coreAddress('경상북도 안동시 송천동 192'),coreAddress('경상북도 안동시 송천동 산192'));
 assert.equal(coreAddress('경기도 가평군 상면 원흥리 산 28-8'),coreAddress('경기도 가평군 상면 원흥리 산28-8'));
 assert.equal(coreAddress('서울특별시 서초구 반포동'),null);
});
test('coordinate edits preserve every raw address, weighted count and administrative classification',()=>{
 const parse=text=>{const c={window:{}};vm.runInNewContext(text,c);const rows=new Map();for(const[s,gs]of Object.entries(c.window.ADDR_DATA))for(const[g,ds]of Object.entries(gs))for(const[d,ps]of Object.entries(ds))for(const p of ps)rows.set(p[2],{s,g,d,p});return rows;};
 const before=parse(cp.execFileSync('git',['show','HEAD:web/addresses.js'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024})),after=parse(fs.readFileSync(path.join(root,'web/addresses.js'),'utf8'));
 assert.equal(before.size,42401);assert.equal(after.size,before.size);
 for(const[a,r]of before){const n=after.get(a);assert.ok(n,a);assert.deepEqual([n.s,n.g,n.d,n.p[2],n.p[3],n.p[5],n.p[6]],[r.s,r.g,r.d,r.p[2],r.p[3],r.p[5],r.p[6]],a);}
});

test('all 145 review records have explicit statuses and unresolved coordinates remain warned',()=>{
 const review=JSON.parse(fs.readFileSync(path.join(root,'web/coordinate-review.json'),'utf8')),context={window:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'web/addresses.js'),'utf8'),context);
 const points=new Map();for(const groups of Object.values(context.window.ADDR_DATA))for(const dongs of Object.values(groups))for(const records of Object.values(dongs))for(const p of records)points.set(p[2],p);
 assert.equal(Object.keys(review.records).length,145);assert.deepEqual(review.summary.statuses,{'address-mismatch':84,unverified:27,verified:23,'representative-only':6,'insufficient-address':5});
 let remaining=0;for(const[address,r]of Object.entries(review.records)){assert.ok(points.has(address));assert.ok(['www.google.com','map.kakao.com'].includes(new URL(r.sourceUrl).hostname));
  if(r.status==='verified'){assert.equal(points.get(address)[4],1);assert.ok(r.plusCode||r.coordinateMethod==='kakao-place-wcongnamul');assert.match(r.note,/층·호수|1층/);}
  else{remaining++;assert.equal(points.get(address)[4],0);if(r.status==='address-mismatch')assert.ok(r.matchedAddress);}
 }
 assert.equal(remaining,review.summary.remaining);assert.equal([...points.values()].filter(p=>!p[4]).length,122);
});

test('Kakao place conversion matches official examples and independent pyproj results',()=>{
 const {kakaoPoint,validateCorrection}=require('../scripts/apply-map-coordinate-followup.cjs');
 const golden=kakaoPoint(500000,972532.3892234056);assert.ok(Math.abs(golden.latitude-37)<1e-8);assert.ok(Math.abs(golden.longitude-127)<1e-10);
 const jeju=kakaoPoint(160082.538257218*2.5,-4680.975749087054*2.5);assert.ok(Math.abs(jeju.latitude-33.450701)<1e-8);assert.ok(Math.abs(jeju.longitude-126.570667)<1e-8);
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/coordinate-followup-20261016.json'),'utf8'));
 for(const row of receipt.records.filter(r=>r.correction)){validateCorrection(row.correction);const c={...row.correction,latitude:row.correction.latitude+.01};assert.throws(()=>validateCorrection(c));}
 assert.throws(()=>validateCorrection({status:'verified',latitude:37,longitude:127,note:'층·호수',matchedTitle:'generic map',sourceUrl:'https://map.kakao.com/?urlX=500000&urlY=972532'}));
});
test('all 35 retries have outcomes, and representative points cannot clear warnings',()=>{
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/coordinate-followup-20261016.json'),'utf8')),review=JSON.parse(fs.readFileSync(path.join(root,'web/coordinate-review.json'),'utf8'));
 assert.equal(receipt.records.length,35);assert.equal(new Set(receipt.records.map(r=>r.address)).size,35);
 assert.deepEqual(receipt.records.reduce((a,r)=>(a[r.outcome]=(a[r.outcome]||0)+1,a),{}),{unresolved:28,verified:5,'representative-only':2});
 for(const r of receipt.records){const live=review.records[r.address];assert.equal(live.followUp.note,r.note);assert.ok(r.sources.some(s=>s.provider==='네이버지도'));if(r.outcome!=='verified'&&live.latestFollowUp?.outcome!=='verified')assert.notEqual(live.status,'verified');}
});
test('remaining 28 map retries preserve unresolved warnings and selected markers support six coordinate changes',()=>{
 const {fromSelectedMarker}=require('../scripts/apply-map-coordinate-followup28.cjs');
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/coordinate-followup28-20261016.json'),'utf8'));
 const review=JSON.parse(fs.readFileSync(path.join(root,'web/coordinate-review.json'),'utf8'));
 const previous=JSON.parse(fs.readFileSync(path.join(root,'data/coordinate-followup-20261016.json'),'utf8'));
 const addressByIndex=new Map(previous.records.filter(r=>r.outcome==='unresolved').map(r=>[r.index,r.address]));
 const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'web/addresses.js'),'utf8'),context);
 const points=new Map();for(const gs of Object.values(context.window.ADDR_DATA))for(const ds of Object.values(gs))for(const ps of Object.values(ds))for(const p of ps)points.set(p[2],p);
 assert.equal(receipt.records.length,28);assert.equal(new Set(receipt.records.map(r=>r.index)).size,28);
 assert.deepEqual(receipt.records.reduce((n,r)=>(n[r.outcome]=(n[r.outcome]||0)+1,n),{}),{unresolved:22,'representative-only':4,'address-conflict-building-point':1,verified:1});
 for(const row of receipt.records){const address=addressByIndex.get(row.index),p=points.get(address),r=review.records[address];
  assert.ok(address&&p&&r);assert.equal(r.latestFollowUp.index,row.index);assert.equal(r.latestFollowUp.outcome,row.outcome);
  if(!row.correction){assert.equal(p[4],0);assert.notEqual(r.status,'verified');continue;}
  const point=fromSelectedMarker(row);assert.ok(Math.abs(p[0]-point.latitude)<1e-9);assert.ok(Math.abs(p[1]-point.longitude)<1e-9);
  assert.equal(p[4],row.outcome==='verified'?1:0);
 }
});
