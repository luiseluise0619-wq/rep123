// Only apply human-reviewed exact address/building matches from visible Maps UI.
// No credentials, undocumented endpoints, nearby-result fallbacks or fabricated coordinates.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),ALPHABET='23456789CFGHJMPQRVWX';
function decodePlusCode(code){
 assert.match(code,/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,7}$/);
 const chars=code.replace('+','');let lat=-90,lon=-180,latStep=20,lonStep=20;
 for(let i=0;i<10;i+=2){lat+=ALPHABET.indexOf(chars[i])*latStep;lon+=ALPHABET.indexOf(chars[i+1])*lonStep;if(i<8){latStep/=20;lonStep/=20;}}
 for(let i=10;i<chars.length;i++){const n=ALPHABET.indexOf(chars[i]);latStep/=5;lonStep/=4;lat+=Math.floor(n/4)*latStep;lon+=(n%4)*lonStep;}
 return {latitude:Number((lat+latStep/2).toFixed(8)),longitude:Number((lon+lonStep/2).toFixed(8)),cellLatitudeDegrees:latStep,cellLongitudeDegrees:lonStep};
}
function norm(s){return String(s||'').normalize('NFKC').replace(/^전남광주통합특별시 /,'전라남도 ').replace(/^세종특별자치시 세종특별자치시 /,'세종특별자치시 ').replace(/^전라북도 /,'전북특별자치도 ').replace(/^강원도 /,'강원특별자치도 ').replace(/산\s+(\d)/g,'산$1').replace(/\s+/g,' ').trim();}
function coreAddress(s){const clean=norm(s).replace(/[\uE000-\uF8FF]/g,'').trim();const m=clean.match(/^(.*?(?:동\d+가|동|가|리|읍|면|로|길)\s+(?:산)?\d+(?:-\d+)?)(?=\s|,|\(|$)/);return m?m[1].replace(/\s/g,''):null;}
function metres(a,b){const rad=Math.PI/180,dlat=(b[0]-a[0])*rad,dlon=(b[1]-a[1])*rad,z=Math.sin(dlat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dlon/2)**2;return Math.round(6371008.8*2*Math.asin(Math.sqrt(Math.min(1,z))));}
function main(){
 const [reviewFile,candidatesFile]=process.argv.slice(2);assert.ok(reviewFile&&candidatesFile,'Pass the two recorded Maps UI evidence files');
 const observations=JSON.parse(fs.readFileSync(reviewFile,'utf8')),candidates=JSON.parse(fs.readFileSync(candidatesFile,'utf8'));
 const publicReview=path.join(ROOT,'web/coordinate-review.json');
 const baseline=JSON.parse(fs.readFileSync(fs.existsSync(publicReview)?publicReview:path.join(ROOT,'web/map-quality.json'),'utf8'));
 assert.equal(observations.length,145);assert.equal(new Set(observations.map(r=>r.address)).size,145);
 assert.deepEqual(observations.map(r=>r.address).sort(),baseline.records?Object.keys(baseline.records).sort():baseline.coordinates.map(r=>r.address).sort());
 const file=path.join(ROOT,'web/addresses.js'),text=fs.readFileSync(file,'utf8'),tree=JSON.parse(text.replace(/^window\.ADDR_DATA\s*=\s*/,'').trim().replace(/;$/,''));
 const points=new Map();for(const gs of Object.values(tree))for(const ds of Object.values(gs))for(const ps of Object.values(ds))for(const p of ps)points.set(p[2],p);
 assert.equal(points.size,42401);const total=[...points.values()].reduce((n,p)=>n+p[3],0);assert.equal(total,44075);
 const approved=new Set([27,29,36,41,42,43,49,54,59,82,87,102,104,105,107,124,134]);
 const approvedNames={36:'위례리버스토리 오피스텔',41:'이든앤스페이스',42:'동탄IT밸리2',43:'동탄IT밸리2',54:'미사센텀비즈',102:'평화시장',104:'평화시장',105:'평화시장',107:'평화시장',134:'용문역'};
 const precise=new Map();for(const r of candidates){const url=new URL(r.url);if(url.hostname==='www.google.com'&&url.pathname.startsWith('/maps/place/')&&/!20s([23456789CFGHJMPQRVWX]{8}%2B[23456789CFGHJMPQRVWX]{2,7})/i.test(r.url))precise.set(r.index,r);}
 const records={},changes=[];
 for(const r of observations){const p=points.get(r.address);assert.ok(p);const sourceCore=coreAddress(r.query),matched=(r.addresses||[]).map(norm).find(s=>coreAddress(s))||'',foundCore=coreAddress(matched);
  let status='unverified',note='원주소와 일치하는 단일 위치를 확인하지 못해 기존 근사 좌표를 유지했습니다.';
  if(!/\d/.test(r.query)){status='insufficient-address';note='원자료에 번지·건물명이 없어 특정 건물의 좌표를 정할 수 없습니다.';}
  else if(sourceCore&&foundCore&&sourceCore!==foundCore){status='address-mismatch';note='지도 검색에서 원주소와 다른 번지가 반환되어 그 위치로 변경하지 않았습니다.';}
  const record={status,matchedAddress:matched.replace(/[\uE000-\uF8FF]/g,'').trim(),note,source:'Google 지도',sourceUrl:r.url,checkedAt:r.checkedAt};
  if(approved.has(r.index)){
   const proof=precise.get(r.index);assert.ok(proof,'Missing final Maps place coordinates for '+r.index);
   const heading=(proof.headings||[])[0];if(approvedNames[r.index])assert.equal(heading,approvedNames[r.index]);else assert.equal(coreAddress(heading),sourceCore,'Exact parcel/road address must match');
   const full=decodeURIComponent(proof.url).match(/!20s([23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,7})/)[1],position=decodePlusCode(full);
   assert.ok(position.latitude>=33&&position.latitude<=39&&position.longitude>=124&&position.longitude<=132);
   const old=[p[0],p[1]],next=[position.latitude,position.longitude];
   changes.push({address:r.address,index:r.index,before:old,after:next,movedMetres:metres(old,next),plusCode:full,sourceUrl:proof.url,matchedTitle:heading});
   p[0]=next[0];p[1]=next[1];p[4]=1;
   Object.assign(record,{status:'verified',matchedAddress:(proof.addresses||[]).map(norm).find(s=>s.length>5)?.replace(/[\uE000-\uF8FF]/g,'').trim()||heading,note:'원주소의 건물명 또는 도로명·지번이 지도 결과와 일치해 해당 지도 위치를 반영했습니다. 층·호수의 위치나 실제 방문을 검증한 것은 아닙니다.',sourceUrl:proof.url,checkedAt:proof.checkedAt,plusCode:full});
  }else{p[4]=0;}
  records[r.address]=record;
 }
 assert.equal(changes.length,approved.size);assert.equal([...points.values()].reduce((n,p)=>n+p[3],0),total);
 const summary={checked:145,verified:changes.length,remaining:145-changes.length,statuses:Object.values(records).reduce((c,r)=>(c[r.status]=(c[r.status]||0)+1,c),{})};
 const result={asOf:'2026-10-16',summary,records};
 fs.writeFileSync(file,'window.ADDR_DATA = '+JSON.stringify(tree)+';\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-review.js'),'window.COORD_REVIEW = '+JSON.stringify(result)+';\n');
 fs.writeFileSync(path.join(ROOT,'web/coordinate-review.json'),JSON.stringify(result,null,2)+'\n');
 fs.writeFileSync(path.join(path.dirname(reviewFile),'coordinate-changes-applied.json'),JSON.stringify({summary,changes},null,2)+'\n');
 console.log(JSON.stringify({summary,changes},null,2));
}
if(require.main===module)main();module.exports={decodePlusCode,coreAddress};
