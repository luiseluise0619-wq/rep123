// Exhaustive source/link validation and representative uploads use fake MYBOX only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,fakeJpeg}=require('./helpers/photo-harness.cjs');
const root=path.resolve(__dirname,'..'),sourceText=fs.readFileSync(path.join(root,'web/addresses.js'),'utf8'),context={window:{}};
vm.runInNewContext(sourceText,context);vm.runInNewContext(fs.readFileSync(path.join(root,'web/photo-config.js'),'utf8'),context);
const entries=[];for(const [province,groups]of Object.entries(context.window.ADDR_DATA))for(const [district,dongs]of Object.entries(groups))for(const [dong,records]of Object.entries(dongs))for(const point of records)entries.push({province,district,dong,point});
test('all 42,401 raw addresses preserve exact photo links and pass server membership with unchanged classification',()=>{
 const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8'),photoFunction=html.match(/function photoUrl\(address\)\{[\s\S]*?\n\}/)[0];vm.runInNewContext(photoFunction,context);
 const h=harness({sourceText,requireCapture:true}),before=h.calls();let checked=0;
 const result=h.app.rpc_(()=>{for(const entry of entries){const raw=entry.point[2],url=new URL(context.photoUrl(raw),'https://rep123-seven.vercel.app/');
  assert.equal(url.pathname,'/photo');assert.equal(url.searchParams.get('address'),raw);assert.ok(raw.length<=1000&&!/[\u0000-\u001f]/.test(raw));
  const info=h.app.assertAddress_(raw);assert.equal(info.province,entry.province);assert.equal(info.district,entry.district);assert.equal(info.dong,entry.dong);checked++;
 }return checked;});
 assert.equal(result.ok,true,'every exact source address must pass, checked '+checked);assert.equal(result.data,42401);assert.equal(h.calls()-before,1,'one source download and one index build per RPC');assert.equal(h.app.PHOTO_SOURCE_INDEX_,null);
 assert.equal(h.app.getPublicStatus('원자료에 없는 가짜 주소','a'.repeat(64)).code,'ADDRESS');
});
test('all 17 provinces support two signed camera-only uploads and status re-read in fake storage',()=>{
 const h=harness({sourceText,requireCapture:true}),key='a'.repeat(64),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 for(const province of Object.keys(context.window.ADDR_DATA)){
  const address=entries.find(r=>r.province===province).point[2];assert.equal(h.app.getPublicStatus(address,key).ok,true,province);
  for(let slot=1;slot<=2;slot++){const permit=h.app.beginPublicCapture(key,address);assert.equal(permit.ok,true,province);
   const result=h.app.uploadPublicPhoto(key,address,{base64:fakeJpeg(slot).toString('base64'),visitDate:day,confirmReadable:true,publicShare:true,captureTicket:permit.data.ticket,capturedAt:Date.now()});assert.equal(result.ok,true,province+' '+JSON.stringify(result));
  }
  const status=h.app.getPublicStatus(address,key);assert.equal(status.ok,true);assert.equal(status.data.totalCount,2,province);assert.equal(status.data.photos.every(p=>p.canDelete),true);
 }
 assert.equal(h.resources.filter(r=>r.type==='file'&&r.name.endsWith('.jpg')).length,34);
});
test('admin identity preflight keeps authentication but avoids a redundant storage request',()=>{
 const h=harness(),before=h.calls(),identity=h.app.getStatus(h.session,'',true);assert.equal(identity.ok,true);assert.equal(identity.data.role,'admin');assert.equal(h.calls(),before);
 assert.equal(h.app.getStatus('invalid-session','',true).data.authenticated,false);assert.equal(h.calls(),before);
});
