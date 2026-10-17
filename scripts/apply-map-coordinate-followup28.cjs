// Apply the second, 28-address map review. The evidence file is the sole input
// for corrections; raw addresses, classifications and business counts stay put.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {kakaoPoint}=require('./apply-map-coordinate-followup.cjs');
const ROOT=path.resolve(__dirname,'..');

function fromSelectedMarker(row){
 const c=row.correction,u=new URL(c.sourceUrl);
 assert.equal(u.hostname,'map.kakao.com');
 const x=Number(u.searchParams.get('urlX')),y=Number(u.searchParams.get('urlY'));
 assert.ok(x>0&&y>0&&Number.isFinite(x)&&Number.isFinite(y));
 if(row.index===93){
  assert.equal(u.searchParams.get('q'),'서울 강서구 가양동 33-1');
  const other=new URL(c.secondParcelUrl);
  assert.equal(other.hostname,'map.kakao.com');
  assert.equal(other.searchParams.get('q'),'서울 강서구 가양동 33-2');
  assert.ok(Math.abs(Number(other.searchParams.get('urlX'))-x)<100);
  assert.ok(Math.abs(Number(other.searchParams.get('urlY'))-y)<100);
 }else{
  assert.ok(u.searchParams.get('itemId'));
  assert.equal(u.searchParams.get('itemId'),u.searchParams.get('srcid'));
  assert.ok(u.searchParams.get('q'));
 }
 assert.ok(c.matchedTitle&&c.matchedAddress&&c.note);
 const point=kakaoPoint(x,y);
 assert.ok(point.latitude>=33&&point.latitude<=39&&point.longitude>=124&&point.longitude<=132);
 return point;
}

function apply(receipt,previous,tree,review){
 const expected=previous.records.filter(r=>r.outcome==='unresolved');
 assert.equal(expected.length,28);
 assert.equal(receipt.records.length,28);
 const byIndex=new Map(expected.map(r=>[r.index,r]));
 assert.equal(new Set(receipt.records.map(r=>r.index)).size,28);
 const points=new Map();
 for(const gs of Object.values(tree))for(const ds of Object.values(gs))for(const ps of Object.values(ds))for(const p of ps){assert.ok(!points.has(p[2]));points.set(p[2],p);}
 assert.equal(points.size,42401);
 assert.equal([...points.values()].reduce((n,p)=>n+p[3],0),44075);
 const changes=[];
 for(const row of receipt.records){
  const old=byIndex.get(row.index);
  assert.ok(old,`Unexpected follow-up index ${row.index}`);
  const address=old.address,p=points.get(address),r=review.records[address];
  assert.ok(p&&r,`Exact raw address missing: ${address}`);
  assert.ok(row.query&&row.finding&&row.outcome);
  const latest={index:row.index,query:row.query,finding:row.finding,outcome:row.outcome,checkedAt:receipt.asOf,
   sourceUrl:'https://map.kakao.com/?q='+encodeURIComponent(row.query)};
  r.latestFollowUp=latest;
  r.note=row.correction?row.correction.note:'카카오맵 재확인: '+row.finding;
  r.checkedAt=receipt.asOf;
  if(!row.correction){
   assert.equal(row.outcome,'unresolved');
   assert.notEqual(r.status,'verified');
   assert.equal(p[4],0);
   r.matchedAddress=row.finding;
   r.source='카카오맵 재검색';r.sourceUrl=latest.sourceUrl;
   continue;
  }
  const c=row.correction;
  assert.equal(c.status,row.outcome==='address-conflict-building-point'?'address-mismatch':row.outcome);
  const point=fromSelectedMarker(row),before=p.slice(0,2);
  p[0]=point.latitude;p[1]=point.longitude;p[4]=c.status==='verified'?1:0;
  Object.assign(r,{status:c.status,matchedAddress:c.matchedAddress,matchedTitle:c.matchedTitle,
   source:row.index===93?'카카오맵 · 두 필지 공유 마커':'카카오맵 · 선택 건물 마커',
   sourceUrl:c.sourceUrl,coordinateMethod:row.index===93?'kakao-selected-parcel-share':'kakao-place-wcongnamul',
   coordinatePrecision:c.status==='verified'?'parcel':c.status==='address-mismatch'?'building-with-address-conflict':'complex-representative'});
  delete r.plusCode;
  changes.push({index:row.index,address,before,after:[p[0],p[1]],status:r.status});
 }
 const statuses=Object.values(review.records).reduce((n,r)=>(n[r.status]=(n[r.status]||0)+1,n),{});
 review.summary={checked:145,verified:statuses.verified||0,remaining:145-(statuses.verified||0),statuses};
 const outcomes=receipt.records.reduce((n,r)=>(n[r.outcome]=(n[r.outcome]||0)+1,n),{});
 review.latestFollowUp={asOf:receipt.asOf,scope:28,outcomes,coordinateUpdates:changes.length};
 assert.deepEqual(outcomes,{'unresolved':22,'representative-only':4,'address-conflict-building-point':1,verified:1});
 assert.equal(changes.length,6);
 assert.deepEqual(statuses,{'address-mismatch':84,unverified:27,verified:23,'representative-only':6,'insufficient-address':5});
 assert.equal([...points.values()].filter(p=>!p[4]).length,122);
 return {changes,summary:review.summary,latestFollowUp:review.latestFollowUp};
}

function main(){
 const receipt=JSON.parse(fs.readFileSync(path.join(ROOT,'data/coordinate-followup28-20261016.json'),'utf8'));
 const previous=JSON.parse(fs.readFileSync(path.join(ROOT,'data/coordinate-followup-20261016.json'),'utf8'));
 const addressPath=path.join(ROOT,'web/addresses.js');
 const tree=JSON.parse(fs.readFileSync(addressPath,'utf8').replace(/^window\.ADDR_DATA\s*=\s*/,'').trim().replace(/;$/,''));
 const review=JSON.parse(fs.readFileSync(path.join(ROOT,'web/coordinate-review.json'),'utf8'));
 const result=apply(receipt,previous,tree,review);
 fs.writeFileSync(addressPath,'window.ADDR_DATA = '+JSON.stringify(tree)+';\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-review.json'),JSON.stringify(review,null,2)+'\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-review.js'),'window.COORD_REVIEW = '+JSON.stringify(review)+';\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-followup28.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main();
module.exports={apply,fromSelectedMarker};
