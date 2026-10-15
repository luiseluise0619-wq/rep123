const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../photo-backend/Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../photo-backend/Photo.html'), 'utf8');
const ADDRESS = '서울특별시 영등포구 당산동 1가 1';
const PASSWORD = 'test-only-not-a-real-password';
const signed = b => Array.from(b, x => x > 127 ? x - 256 : x);
const buffer = value => typeof value === 'string' ? Buffer.from(value) : Buffer.from(Array.from(value, x => x & 255));
function fakeJpeg(seed = 1, edge = 100) {
  // Structural fixture, not a decoder/visual-quality test.
  return Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,edge>>8,edge&255,0,100,1,1,17,0,
    255,218,0,8,1,1,0,0,63,0,seed,0,0,255,217]);
}
function harness() {
  const props = new Map([['MYBOX_TOKEN','mbx_pat_unit_test_fake_123456789'],['PHOTO_TEAM_PASSWORD',PASSWORD]]);
  const cache = new Map(), resources = [], reservations = new Map();
  let locked = false, calls = 0, next = 0, used = 0, dropUploadResponse = false;
  const response = (value, status = 200, bytes) => ({getResponseCode:()=>status,
    getContentText:()=>typeof value==='string'?value:JSON.stringify(value), getContent:()=>signed(bytes||Buffer.alloc(0))});
  const sandbox = {
    console, PHOTO_HTML_:html,
    Utilities:{ Charset:{UTF_8:'UTF-8'},DigestAlgorithm:{SHA_256:'sha256'},
      getUuid:()=>crypto.randomUUID(),
      computeDigest:(algorithm,value)=>signed(crypto.createHash('sha256').update(buffer(value)).digest()),
      computeHmacSha256Signature:(value,key)=>signed(crypto.createHmac('sha256',key).update(value).digest()),
      base64EncodeWebSafe:value=>buffer(value).toString('base64url'),
      base64DecodeWebSafe:value=>signed(Buffer.from(value,'base64url')),
      base64Encode:value=>buffer(value).toString('base64'), base64Decode:value=>signed(Buffer.from(value,'base64')),
      formatDate:(date,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date),
      newBlob(value,type,name){return {bytes:buffer(value),type,name,getDataAsString:()=>buffer(value).toString('utf8')};}},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props.get(key)||null,setProperty:(key,value)=>props.set(key,value)})},
    CacheService:{getScriptCache:()=>({get:key=>cache.get(key)||null,put:(key,value)=>cache.set(key,value),remove:key=>cache.delete(key)})},
    LockService:{getScriptLock:()=>({tryLock:()=>{if(locked)return false;locked=true;return true;},releaseLock:()=>{locked=false;}})},
    HtmlService:{createTemplate:()=>({evaluate(){return {setTitle(){return this;},addMetaTag(){return this;}};}})},
    UrlFetchApp:{fetch(url,options={}) {
      assert.equal(locked,true,'all external fetches must be serialized'); calls++;
      if (url === 'https://rep123-seven.vercel.app/addresses.js') return response('window.ADDR_DATA = '+JSON.stringify({서울:{영등포구:{당산동:[[0,0,ADDRESS,2,1,'code','서울']]}}})+';');
      if (url.startsWith('https://upload.example.net/v1/storage/upload?')) {
        const token = new URL(url).searchParams.get('id'), pending=reservations.get(token);
        assert.ok(pending); assert.equal(options.followRedirects,false);
        const blob=options.payload.Filedata; assert.equal(blob.type,'image/jpeg');
        assert.equal(blob.bytes.length,pending.size);
        resources.push({...pending,bytes:blob.bytes,resourceId:'file'+(++next),type:'file',createdAt:new Date().toISOString()}); used+=blob.bytes.length;
        if(dropUploadResponse){dropUploadResponse=false;throw new Error('upstream error with SECRET_SIGNED_URL');}
        return response({},201);
      }
      if (url.startsWith('https://download.example.net/v1/storage/download?')) {
        const id=new URL(url).searchParams.get('id'),file=resources.find(r=>r.resourceId===id); return response({},200,file.bytes);
      }
      const parsed=new URL(url),pathname=parsed.pathname.replace('/v1','');
      assert.equal(options.headers.Authorization,'Bearer '+props.get('MYBOX_TOKEN'));
      assert.equal(options.followRedirects,false,'PAT must never follow redirects');
      if (pathname === '/drive/storage') return response({quotaBytes:30*1024**3,usedBytes:used});
      if (pathname === '/drive/folders' && options.method==='post') {
        const body=JSON.parse(options.payload),folder={resourceId:'folder'+(++next),parentId:body.parentId||'',name:body.folderName,type:'folder'};
        resources.push(folder); return response(folder,201);
      }
      if (pathname === '/drive/files' && options.method==='post') {
        const body=JSON.parse(options.payload); assert.equal(body.isOverwrite,false);
        const id=String(++next); reservations.set(id,{parentId:body.parentId,name:body.fileName,size:body.fileSize});
        return response({uploadUrl:'https://upload.example.net/v1/storage/upload?id='+id},201);
      }
      if (pathname.startsWith('/drive/files/') && pathname.endsWith('/download')) {
        const id=decodeURIComponent(pathname.split('/')[3]); return response({downloadUrl:'https://download.example.net/v1/storage/download?id='+id});
      }
      if (pathname==='/drive/resources' || /^\/drive\/folders\/[^/]+\/resources$/.test(pathname)) {
        const parent=pathname==='/drive/resources'?'':decodeURIComponent(pathname.split('/')[3]);
        return response({resources:resources.filter(r=>r.parentId===parent),responseMetaData:{}});
      }
      throw new Error('Unexpected URL '+url);
    }}
  };
  vm.createContext(sandbox); vm.runInContext(source,sandbox);
  const login=sandbox.loginPhoto('테스트직원',PASSWORD); assert.equal(login.ok,true);
  return {app:sandbox,props,cache,resources,session:login.data.session,
    setUsed:value=>{used=value;},setLocked:value=>{locked=value;},
    dropNextUploadResponse:()=>{dropUploadResponse=true;},calls:()=>calls};
}
const photo=(seed=1)=>({base64:fakeJpeg(seed).toString('base64'),visitDate:'2026-01-01',confirmReadable:true});
test('unconfigured service is closed; no PAT or raw upstream error is exposed',()=>{
  const h=harness(); h.props.delete('MYBOX_TOKEN');
  assert.equal(h.app.getStatus('',ADDRESS).data.ready,false);
  assert.equal(h.app.loginPhoto('담당자',PASSWORD).code,'SETUP');
  assert.equal(h.calls(),0);
});
test('wrong passwords, forged/expired sessions and invalid addresses cannot upload/read',()=>{
  const h=harness();
  assert.equal(h.app.loginPhoto('담당자','wrong').code,'LOGIN');
  assert.equal(h.app.uploadPhoto(h.session+'x',ADDRESS,photo()).code,'AUTH');
  assert.equal(h.app.getPhoto('',ADDRESS,1).code,'AUTH');
  const oldPayload=Buffer.from(JSON.stringify({name:'담당자',exp:Date.now()-1000})).toString('base64url');
  assert.equal(h.app.getPhoto(oldPayload+'.'+h.app.sign_(oldPayload),ADDRESS,1).code,'AUTH');
  assert.equal(h.app.uploadPhoto(h.session,'원자료에 없는 주소',photo()).code,'ADDRESS');
  const old=h.props.get('PHOTO_TEAM_PASSWORD');h.props.set('PHOTO_TEAM_PASSWORD',old+'rotate');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo()).code,'AUTH');
});
test('8-to-15-character team passwords work; fewer than 8 characters stay blocked',()=>{
  const h=harness();h.props.set('PHOTO_TEAM_PASSWORD','test8x9z');
  assert.equal(h.app.loginPhoto('담당자','test8x9z').ok,true);
  h.props.set('PHOTO_TEAM_PASSWORD','short7x');
  assert.equal(h.app.getStatus('',ADDRESS).data.ready,false);
  assert.equal(h.app.loginPhoto('담당자','short7x').code,'SETUP');
});
test('persistent global login guard cannot be bypassed by changing names or clearing cache',()=>{
  const h=harness();
  for(let i=0;i<20;i++)assert.equal(h.app.loginPhoto('새담당자'+i,'wrong').code,'LOGIN');
  h.cache.clear();
  assert.equal(h.app.loginPhoto('다른이름',PASSWORD).code,'RATE_LIMIT');
  const guard=JSON.parse(h.props.get('LOGIN_GUARD'));guard.lockedUntil=Date.now()-1;guard.startedAt=Date.now()-610000;
  h.props.set('LOGIN_GUARD',JSON.stringify(guard));
  assert.equal(h.app.loginPhoto('다른이름',PASSWORD).ok,true);
});
test('two photos per original address including multiple businesses, no third photo/overwrite',()=>{
  const h=harness();
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(1)).ok,true);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(2)).ok,true);
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo(3)).code,'FULL');
  const status=h.app.getStatus(h.session,ADDRESS);
  assert.equal(status.data.photos.length,2);
  assert.deepEqual(Array.from(status.data.photos,p=>p.slot),[1,2]);
  assert.equal(h.resources.filter(r=>r.type==='file').length,2);
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
  assert.equal(h.resources.filter(r=>r.type==='file').length,0);
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
  const first=h.resources.find(r=>r.type==='file');
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
  assert.deepEqual(exposed,['doGet','getStatus','loginPhoto','uploadPhoto','getPhoto']);
});
