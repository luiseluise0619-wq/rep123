const test = require('node:test');
const assert = require('node:assert/strict');
const {harness,fakeJpeg,ADDRESS,PASSWORD,source}=require('./helpers/photo-harness.cjs');
const photo=(seed=1)=>({base64:fakeJpeg(seed).toString('base64'),visitDate:'2026-01-01',confirmReadable:true,publicShare:true});
test('unconfigured service is closed; no PAT or raw upstream error is exposed',()=>{
  const h=harness(); h.props.delete('MYBOX_TOKEN');
  assert.equal(h.app.getStatus('',ADDRESS).data.ready,false);
  assert.equal(h.app.loginPhoto('admin',PASSWORD).code,'SETUP');
  assert.equal(h.calls(),0);
});
test('wrong passwords, forged/expired sessions and invalid addresses cannot upload/read',()=>{
  const h=harness();
  assert.equal(h.app.loginPhoto('admin','wrong').code,'LOGIN');
  assert.equal(h.app.uploadPhoto(h.session+'x',ADDRESS,photo()).code,'AUTH');
  assert.equal(h.app.getPhoto('',ADDRESS,1).code,'AUTH');
  const oldPayload=Buffer.from(JSON.stringify({name:'담당자',exp:Date.now()-1000})).toString('base64url');
  assert.equal(h.app.getPhoto(oldPayload+'.'+h.app.sign_(oldPayload),ADDRESS,1).code,'AUTH');
  assert.equal(h.app.uploadPhoto(h.session,'원자료에 없는 주소',photo()).code,'ADDRESS');
  const old=h.props.get('PHOTO_ADMIN_PASSWORD');h.props.set('PHOTO_ADMIN_PASSWORD',old+'rotate');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo()).code,'AUTH');
});
test('8-to-15-character admin passwords work; old shared password and shorter passwords are blocked',()=>{
  const h=harness();h.props.set('PHOTO_ADMIN_PASSWORD','test8x9z');
  assert.equal(h.app.loginPhoto('admin','test8x9z').ok,true);
  h.props.set('PHOTO_ADMIN_PASSWORD','old-team-password');assert.equal(h.app.getStatus('',ADDRESS).data.ready,false);
  h.props.set('PHOTO_ADMIN_PASSWORD','short7x');
  assert.equal(h.app.getStatus('',ADDRESS).data.ready,false);
  assert.equal(h.app.loginPhoto('admin','short7x').code,'SETUP');
});
test('persistent global login guard cannot be bypassed by changing names or clearing cache',()=>{
  const h=harness();
  for(let i=0;i<20;i++)assert.equal(h.app.loginPhoto('staff'+i,'wrong').code,'LOGIN');
  h.cache.clear();
  assert.equal(h.app.loginPhoto('admin',PASSWORD).code,'RATE_LIMIT');
  const guard=JSON.parse(h.props.get('LOGIN_GUARD'));guard.lockedUntil=Date.now()-1;guard.startedAt=Date.now()-610000;
  h.props.set('LOGIN_GUARD',JSON.stringify(guard));
  assert.equal(h.app.loginPhoto('admin',PASSWORD).ok,true);
});
test('two photos per original address including multiple businesses, no third photo/overwrite',()=>{
  const h=harness();
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(1)).ok,true);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(2)).ok,true);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(3)).code,'FULL');
  const status=h.app.getStatus(h.session,ADDRESS);
  assert.equal(status.data.photos.length,2);
  assert.deepEqual(Array.from(status.data.photos,p=>p.slot),[1,2]);
  assert.equal(h.resources.filter(r=>r.type==='file'&&r.name.endsWith('.jpg')).length,2);
  const read=h.app.getPhoto(h.session,ADDRESS,2);assert.equal(read.ok,true);
  assert.equal(read.data.base64,photo(2).base64);
  assert.ok(!JSON.stringify(status).includes('mbx_pat_'));
  assert.ok(!JSON.stringify(status).includes('resourceId'));
});
test('ambiguous network failure after storage is idempotent on retry',()=>{
  const h=harness();h.dropNextUploadResponse();
  const result=h.app.uploadPhoto(h.session,ADDRESS,photo(1));
  assert.equal(result.code,'SERVICE');assert.ok(!result.message.includes('SECRET'));
  const retry=h.app.uploadPhoto(h.session,ADDRESS,photo(1));
  assert.equal(retry.data.alreadySaved,true);
  assert.equal(retry.data.count,1);
});
test('server rejects oversized/non-JPEG/high-resolution/unconfirmed/invalid-date uploads',()=>{
  const h=harness();
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),confirmReadable:false}).code,'PREVIEW');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),visitDate:'2026-02-30'}).code,'DATE');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),base64:Buffer.alloc(200001).toString('base64')}).code,'SIZE');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),base64:Buffer.alloc(100).toString('base64')}).code,'JPEG');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),base64:fakeJpeg(1,2000).toString('base64')}).code,'DIMENSIONS');
  const metadata=Buffer.concat([Buffer.from([255,216,255,225,0,4,0,0]),fakeJpeg().subarray(2)]);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),base64:metadata.toString('base64')}).code,'METADATA');
});
test('storage and daily communication safety limits fail closed without a payment path',()=>{
  const h=harness();h.setUsed(24000000000-100);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo()).code,'STORAGE');
  assert.equal(h.resources.filter(r=>r.type==='file'&&r.name.endsWith('.jpg')).length,0);
  h.setUsed(0);
  const date=h.app.Utilities.formatDate(new Date(),'Asia/Seoul');
  h.props.set('BUDGET_fetch',JSON.stringify({date,count:10000}));
  assert.equal(h.app.getStatus(h.session,ADDRESS).code,'DAILY_LIMIT');
});
test('browser ICC color profile is allowed but arbitrary APP2 payload is rejected',()=>{
  const h=harness();
  const payload=Buffer.from('ICC_PROFILE\x00\x01\x01color','ascii');
  const length=Buffer.alloc(2);length.writeUInt16BE(payload.length+2);
  const jpg=Buffer.concat([Buffer.from([255,216,255,226]),length,payload,fakeJpeg().subarray(2)]);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),base64:jpg.toString('base64')}).ok,true);
  const arbitrary=Buffer.concat([Buffer.from([255,216,255,226,0,4,65,66]),fakeJpeg().subarray(2)]);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),base64:arbitrary.toString('base64')}).code,'METADATA');
});
test('script lock prevents overlapping mutations; manually-added duplicates stop operations',()=>{
  const h=harness();h.setLocked(true);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo()).code,'BUSY');
  h.setLocked(false);assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo()).ok,true);
  const first=h.resources.find(r=>r.type==='file'&&r.name.endsWith('.jpg'));
  h.resources.push({...first,name:'outside-app.jpg'});
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(2)).code,'MANUAL_CHANGE');
});
test('doGet escapes script tags in user-controlled address; helper functions stay private',()=>{
  let template;
  const h=harness(); h.app.HtmlService.createTemplate=()=>template={evaluate(){return {setTitle(){return this;},addMetaTag(){return this;}};}};
  h.app.doGet({parameter:{address:'</script><img src=x onerror=alert(1)>'}});
  assert.ok(!template.initialJson.includes('<'));
  assert.ok(template.initialJson.includes('\\u003c'));
  const exposed=[...source.matchAll(/^function (\w+)\(/gm)].map(m=>m[1]).filter(n=>!n.endsWith('_'));
  assert.deepEqual(exposed,['doGet','getStatus','loginPhoto','uploadPhoto','getPhoto','listEmployees','manageEmployee','getAdminOverview','getAdminChunk','syncAdminCatalog','getPublicStatus','uploadPublicPhoto','getPublicPhoto','deletePhoto']);
});

test('staff with identical display names see only immutable account-owned photos; admin sees both',()=>{
  const h=harness(),a=h.staff('staff-a'),b=h.staff('staff-b');
  assert.equal(h.app.uploadPhoto(a.session,ADDRESS,photo(1)).ok,true);
  assert.equal(h.app.uploadPhoto(b.session,ADDRESS,photo(2)).ok,true);
  const own=h.app.getStatus(a.session,ADDRESS).data;
  assert.equal(own.photos.length,1);assert.equal(own.photos[0].slot,1);assert.equal(own.totalCount,2);
  assert.equal(h.app.getPhoto(a.session,ADDRESS,2).code,'FORBIDDEN');
  assert.equal(h.app.getPhoto(b.session,ADDRESS,1).code,'FORBIDDEN');
  assert.equal(h.app.getPhoto(a.session,ADDRESS,1).ok,true);
  assert.equal(h.app.getStatus(h.session,ADDRESS).data.photos.length,2);
  assert.equal(h.app.getPhoto(h.session,ADDRESS,2).ok,true);
  assert.equal(h.app.uploadPhoto(b.session,ADDRESS,photo(1)).code,'DUPLICATE');
});

test('staff and unauthenticated requests cannot access ANY administrator RPC',()=>{
  const h=harness(),staff=h.staff('staff-a');
  for(const session of ['',staff.session]) {
    const expected=session?'FORBIDDEN':'AUTH';
    assert.equal(h.app.listEmployees(session).code,expected);
    assert.equal(h.app.manageEmployee(session,'create',{login:'evil',name:'관리자',role:'admin'}).code,expected);
    assert.equal(h.app.getAdminOverview(session).code,expected);
    assert.equal(h.app.getAdminChunk(session,'a').code,expected);
    assert.equal(h.app.syncAdminCatalog(session,true).code,expected);
  }
  const claims=JSON.parse(Buffer.from(staff.session.split('.')[0],'base64url').toString());claims.role='admin';
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  assert.equal(h.app.getAdminOverview(payload+'.'+h.app.sign_(payload)).code,'AUTH');
});

test('legacy photos are admin-only, and v1/v2 shared-name sessions never survive migration',()=>{
  const h=harness(),staff=h.staff('staff-a','입력명');h.app.uploadPhoto(staff.session,ADDRESS,photo());
  const file=h.resources.find(r=>r.name.endsWith('.jpg'));file.name=file.name.replace(/__v3u-[0-9a-f]{32}__/,'__');
  assert.equal(h.app.getStatus(staff.session,ADDRESS).data.photos.length,0);
  assert.equal(h.app.getStatus(staff.session,ADDRESS).data.totalCount,1);
  assert.equal(h.app.getPhoto(staff.session,ADDRESS,1).code,'FORBIDDEN');
  assert.equal(h.app.getPhoto(h.session,ADDRESS,1).ok,true);
  assert.equal(h.app.getStatus(h.session,ADDRESS).data.photos[0].legacy,true);
  const payload=Buffer.from(JSON.stringify({name:'입력명',exp:Date.now()+10000})).toString('base64url');
  assert.equal(h.app.getPhoto(payload+'.'+h.app.sign_(payload),ADDRESS,1).code,'AUTH');
  assert.equal(h.app.loginPhoto('staff-a','old-team-password').code,'LOGIN');
});

test('private links are returned once, hashed at rest, and reset/disable immediately revoke sessions',()=>{
  const h=harness(),a=h.staff('staff-a');h.app.uploadPhoto(a.session,ADDRESS,photo());
  assert.equal(new URL(a.link).searchParams.has('key'),false,'credential must be in fragment, never query');
  assert.equal(new URL(a.link).searchParams.get('build'),h.app.PHOTO_LIMITS_.version,'old shared-login HTML must not be reused from cache');
  assert.equal(a.code.length,16);assert.ok(!JSON.stringify(Object.fromEntries(h.props)).includes(a.code));
  assert.ok(!JSON.stringify(h.app.listEmployees(h.session)).includes(a.code));
  const reset=h.app.manageEmployee(h.session,'reset',{login:'staff-a',id:a.employee.id}).data;
  assert.equal(h.app.getPhoto(a.session,ADDRESS,1).code,'AUTH');
  assert.equal(h.app.loginPhoto('staff-a',a.code).code,'LOGIN');
  const code=new URLSearchParams(new URL(reset.employeeLink).hash.slice(1)).get('key'),next=h.app.loginPhoto('staff-a',code).data.session;
  assert.equal(h.app.getPhoto(next,ADDRESS,1).ok,true,'reset retains immutable ownership');
  h.app.manageEmployee(h.session,'disable',{login:'staff-a',id:a.employee.id});
  assert.equal(h.app.getPhoto(next,ADDRESS,1).code,'AUTH');assert.equal(h.app.loginPhoto('staff-a',code).code,'LOGIN');
  h.app.manageEmployee(h.session,'enable',{login:'staff-a',id:a.employee.id});
  assert.equal(h.app.getPhoto(next,ADDRESS,1).code,'AUTH','enabling must not revive revoked sessions');
  assert.equal(h.app.loginPhoto('staff-a',code).ok,true);
});

test('catalog address/photo totals reconcile with verified files, not weighted business counts',()=>{
  const h=harness(),a=h.staff('staff-a');
  assert.equal(h.app.uploadPhoto(a.session,ADDRESS,photo(1)).data.catalogPending,false);
  assert.equal(h.app.uploadPhoto(a.session,ADDRESS,photo(2)).data.catalogPending,false);
  const overview=h.app.getAdminOverview(h.session).data;
  assert.equal(overview.addresses,1);assert.equal(overview.photos,2);assert.equal(overview.pending,0);
  const rows=h.app.getAdminChunk(h.session,overview.chunks[0]).data.rows;
  assert.equal(rows.length,1);assert.equal(rows[0].address,ADDRESS);assert.equal(rows[0].photos.length,2);
  assert.ok(rows[0].photos.every(p=>p.ownerId===a.employee.id));
  assert.ok(!JSON.stringify(rows).includes('resourceId'));
});

test('catalog failure never hides saved photos; pending writes are repaired by resumable MYBOX scan',()=>{
  const h=harness(),a=h.staff('staff-a');h.failCatalog(true);
  const uploaded=h.app.uploadPhoto(a.session,ADDRESS,photo());
  assert.equal(uploaded.ok,true);assert.equal(uploaded.data.catalogPending,true);
  assert.equal(h.app.getPhoto(a.session,ADDRESS,1).ok,true);
  assert.equal(h.app.getAdminOverview(h.session).data.pending,1);
  h.failCatalog(false);
  let done=false;
  for(let step=0;step<30;step++){const result=h.app.syncAdminCatalog(h.session,false);assert.equal(result.ok,true,JSON.stringify(result));if(!result.data.scan.active&&!result.data.pending){done=true;break;}}
  assert.equal(done,true);const overview=h.app.getAdminOverview(h.session).data;
  assert.equal(overview.addresses,1);assert.equal(overview.photos,1);assert.equal(overview.pending,0);assert.equal(overview.scanComplete,true);
});

test('full re-scan removes stale catalog rows after external MYBOX changes without deleting originals',()=>{
  const h=harness();h.app.uploadPhoto(h.session,ADDRESS,photo());
  const file=h.resources.find(r=>r.name.endsWith('.jpg'));h.resources.splice(h.resources.indexOf(file),1);
  for(let step=0;step<30;step++){const result=h.app.syncAdminCatalog(h.session,step===0);assert.equal(result.ok,true,JSON.stringify(result));if(!result.data.scan.active)break;}
  const overview=h.app.getAdminOverview(h.session).data;assert.equal(overview.photos,0);assert.equal(overview.addresses,0);
  assert.ok(h.resources.every(r=>r.type==='folder'||r.name.endsWith('.json')));
});
