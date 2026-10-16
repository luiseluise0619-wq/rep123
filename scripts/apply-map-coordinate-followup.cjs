// Apply only the explicit, reviewed decisions in the committed evidence receipt.
// This is not a geocoder: a matching search string or map centre is not a coordinate.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {decodePlusCode}=require('./apply-map-coordinate-review.cjs');
const ROOT=path.resolve(__dirname,'..');
// Inverse Korean Central Belt 2000 (GRS80, EPSG:5181). Kakao WCONGNAMUL
// uses the same metre coordinates multiplied by 2.5. Checked against the
// published Kakao examples and an independent pyproj 3.8.0 conversion.
function kakaoPoint(x,y){
 assert.ok(Number.isFinite(x)&&Number.isFinite(y));
 const a=6378137,f=1/298.257222101,e=2*f-f*f,ep=e/(1-e),rad=Math.PI/180;
 const meridian=p=>a*((1-e/4-3*e*e/64-5*e**3/256)*p-(3*e/8+3*e*e/32+45*e**3/1024)*Math.sin(2*p)+(15*e*e/256+45*e**3/1024)*Math.sin(4*p)-35*e**3/3072*Math.sin(6*p));
 const m=y/2.5-500000+meridian(38*rad),mu=m/(a*(1-e/4-3*e*e/64-5*e**3/256)),e1=(1-Math.sqrt(1-e))/(1+Math.sqrt(1-e));
 const p=mu+(3*e1/2-27*e1**3/32)*Math.sin(2*mu)+(21*e1*e1/16-55*e1**4/32)*Math.sin(4*mu)+151*e1**3/96*Math.sin(6*mu)+1097*e1**4/512*Math.sin(8*mu);
 const n=a/Math.sqrt(1-e*Math.sin(p)**2),r=a*(1-e)/(1-e*Math.sin(p)**2)**1.5,t=Math.tan(p)**2,c=ep*Math.cos(p)**2,d=(x/2.5-200000)/n;
 const lat=p-n*Math.tan(p)/r*(d*d/2-(5+3*t+10*c-4*c*c-9*ep)*d**4/24+(61+90*t+298*c+45*t*t-252*ep-3*c*c)*d**6/720);
 const lon=127*rad+(d-(1+2*t+c)*d**3/6+(5-2*c+28*t-3*c*c+8*ep+24*t*t)*d**5/120)/Math.cos(p);
 return {latitude:lat/rad,longitude:lon/rad};
}
function metres(a,b){const rad=Math.PI/180,dlat=(b[0]-a[0])*rad,dlon=(b[1]-a[1])*rad,z=Math.sin(dlat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dlon/2)**2;return Math.round(6371008.8*2*Math.asin(Math.sqrt(Math.min(1,z))));}
function validateCorrection(c){
 assert.ok(['verified','representative-only'].includes(c.status));
 assert.ok(c.latitude>=33&&c.latitude<=39&&c.longitude>=124&&c.longitude<=132);
 const u=new URL(c.sourceUrl);
 if(u.hostname==='map.kakao.com'){
  assert.ok(u.searchParams.get('itemId')&&u.searchParams.get('itemId')===u.searchParams.get('srcid'),'An actual selected place, not a generic map centre, is required');
  for(const key of ['urlX','urlY'])assert.ok(Number.isFinite(Number(u.searchParams.get(key)))&&Number(u.searchParams.get(key))>0);
  assert.ok(u.searchParams.get('q'));assert.ok(c.matchedTitle);
  const decoded=kakaoPoint(Number(u.searchParams.get('urlX')),Number(u.searchParams.get('urlY')));
  assert.ok(Math.abs(decoded.latitude-c.latitude)<2e-8&&Math.abs(decoded.longitude-c.longitude)<2e-8,'Coordinate must equal the explicit place point after CRS conversion');
 }else{
  assert.equal(u.hostname,'www.google.com');assert.ok(u.pathname.startsWith('/maps/place/'));
  assert.ok(decodeURIComponent(c.sourceUrl).includes('!20s'+c.plusCode));
  const decoded=decodePlusCode(c.plusCode);assert.equal(c.latitude,decoded.latitude);assert.equal(c.longitude,decoded.longitude);
 }
 assert.match(c.note,c.status==='verified'?/층·호수/:/代表|대표/);
}
function apply(receipt,tree,review){
 assert.equal(receipt.records.length,35);assert.equal(new Set(receipt.records.map(r=>r.address)).size,35);
 assert.equal(receipt.records.filter(r=>r.previousGroup==='same-primary-address').length,15);
 assert.equal(receipt.records.filter(r=>r.previousGroup==='detail-unconfirmed').length,20);
 const points=new Map();for(const gs of Object.values(tree))for(const ds of Object.values(gs))for(const ps of Object.values(ds))for(const p of ps)points.set(p[2],p);
 assert.equal(points.size,42401);assert.equal([...points.values()].reduce((n,p)=>n+p[3],0),44075);
 const changes=[];
 for(const row of receipt.records){
  const p=points.get(row.address),r=review.records[row.address];assert.ok(p&&r,'Missing exact raw address');
  r.followUp={index:row.index,previousGroup:row.previousGroup,outcome:row.outcome,checkedAt:row.checkedAt,note:row.note,sources:row.sources};
  r.note=row.note;r.checkedAt=row.checkedAt;
  if(row.correction){
   const c=row.correction;validateCorrection(c);const before=p.slice(0,2),after=[c.latitude,c.longitude];
   Object.assign(r,{status:c.status,matchedAddress:c.matchedAddress,matchedTitle:c.matchedTitle,source:c.plusCode?'Google 지도 · 네이버지도 대조':'카카오맵 · 건물명/주소 대조',sourceUrl:c.sourceUrl,coordinateMethod:c.plusCode?'full-plus-code':'kakao-place-wcongnamul',coordinatePrecision:c.status==='representative-only'?'complex-representative':row.index===120?'parcel':'building'});
   if(c.plusCode)r.plusCode=c.plusCode;else delete r.plusCode;
   p[0]=after[0];p[1]=after[1];p[4]=c.status==='verified'?1:0;
   changes.push({index:row.index,address:row.address,before,after,movedMetres:metres(before,after),status:c.status});
  }else assert.notEqual(r.status,'verified','An unresolved follow-up must not clear its warning');
 }
 const records=Object.values(review.records),statuses=records.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{});
 review.summary={checked:records.length,verified:statuses.verified||0,remaining:records.filter(r=>r.status!=='verified').length,statuses};
 review.followUp={asOf:receipt.asOf,scope:receipt.scope,summary:receipt.summary};
 assert.equal(changes.length,7);assert.equal(review.summary.verified,22);assert.equal(review.summary.remaining,123);
 assert.equal([...points.values()].filter(p=>!p[4]).length,123);
 return {changes,summary:review.summary};
}
function main(){const file=process.argv[2]||path.join(ROOT,'data/coordinate-followup-20261016.json'),receipt=JSON.parse(fs.readFileSync(file,'utf8')),addrFile=path.join(ROOT,'web/addresses.js'),tree=JSON.parse(fs.readFileSync(addrFile,'utf8').replace(/^window\.ADDR_DATA\s*=\s*/,'').trim().replace(/;$/,'')),review=JSON.parse(fs.readFileSync(path.join(ROOT,'web/coordinate-review.json'),'utf8'));
 const result=apply(receipt,tree,review);
 fs.writeFileSync(addrFile,'window.ADDR_DATA = '+JSON.stringify(tree)+';\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-review.json'),JSON.stringify(review,null,2)+'\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-review.js'),'window.COORD_REVIEW = '+JSON.stringify(review)+';\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-followup.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main();module.exports={apply,validateCorrection,kakaoPoint};
