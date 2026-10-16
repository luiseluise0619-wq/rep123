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
 assert.equal(Object.keys(review.records).length,145);assert.deepEqual(review.summary.statuses,{'address-mismatch':84,unverified:39,verified:17,'insufficient-address':5});
 let remaining=0;for(const[address,r]of Object.entries(review.records)){assert.ok(points.has(address));assert.equal(new URL(r.sourceUrl).hostname,'www.google.com');
  if(r.status==='verified'){assert.equal(points.get(address)[4],1);assert.ok(r.plusCode);assert.match(r.note,/층·호수/);}
  else{remaining++;assert.equal(points.get(address)[4],0);if(r.status==='address-mismatch')assert.ok(r.matchedAddress);}
 }
 assert.equal(remaining,review.summary.remaining);assert.equal([...points.values()].filter(p=>!p[4]).length,128);
});
