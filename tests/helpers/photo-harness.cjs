const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname,'../../web/lib/visit-distance.js'),'utf8')+'\n'+['Code.gs','Access.gs','Catalog.gs','Public.gs','Capture.gs','Diagnostics.gs'].map(name=>fs.readFileSync(path.join(__dirname,'../../photo-backend',name),'utf8')).join('\n');
const html = fs.readFileSync(path.join(__dirname, '../../photo-backend/Photo.html'), 'utf8');
const ADDRESS = '서울특별시 영등포구 당산동 1가 1';
const PASSWORD = 'test-only-not-a-real-password';
const signed = b => Array.from(b, x => x > 127 ? x - 256 : x);
const buffer = value => typeof value === 'string' ? Buffer.from(value) : Buffer.from(Array.from(value, x => x & 255));
function fakeJpeg(seed = 1, edge = 100) {
  // Structural fixture, not a decoder/visual-quality test.
  return Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,edge>>8,edge&255,0,100,1,1,17,0,
    255,218,0,8,1,1,0,0,63,0,seed,0,0,255,217]);
}
function harness({sourceText,requireCapture=false} = {}) {
  const props = new Map([['MYBOX_TOKEN','mbx_pat_unit_test_fake_123456789'],['PHOTO_ADMIN_PASSWORD',PASSWORD],['PHOTO_TEAM_PASSWORD','old-team-password']]);
  const cache = new Map(), resources = [], reservations = new Map();
  let locked = false, calls = 0, next = 0, used = 0, dropUploadResponse = false, failCatalog=false, dropDeleteResponse=false;
  const trash=[];
  const response = (value, status = 200, bytes) => ({getResponseCode:()=>status,
    getContentText:()=>bytes?bytes.toString('utf8'):typeof value==='string'?value:JSON.stringify(value), getContent:()=>signed(bytes||Buffer.alloc(0))});
  const sandbox = {
    console:{log(){},warn(){}}, PHOTO_DIAG_JPEG_:fakeJpeg().toString('base64'),PHOTO_HTML_:html, PHOTO_ADMIN_HTML_:'admin-html', PHOTO_BRIDGE_HTML_:'bridge-html',PHOTO_LANDING_HTML_:html,
    Utilities:{ Charset:{UTF_8:'UTF-8'},DigestAlgorithm:{SHA_256:'sha256'},
      getUuid:()=>crypto.randomUUID(),
      computeDigest:(algorithm,value)=>signed(crypto.createHash('sha256').update(buffer(value)).digest()),
      computeHmacSha256Signature:(value,key)=>signed(crypto.createHmac('sha256',key).update(value).digest()),
      base64EncodeWebSafe:value=>buffer(value).toString('base64url'),
      base64DecodeWebSafe:value=>signed(Buffer.from(value,'base64url')),
      base64Encode:value=>buffer(value).toString('base64'), base64Decode:value=>signed(Buffer.from(value,'base64')),
      formatDate:(date,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date),
      newBlob(value,type,name){return {bytes:buffer(value),type,name,getBytes:()=>signed(buffer(value)),getDataAsString:()=>buffer(value).toString('utf8')};}},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props.get(key)||null,setProperty:(key,value)=>props.set(key,value),deleteProperty:key=>props.delete(key),getProperties:()=>Object.fromEntries(props)})},
    CacheService:{getScriptCache:()=>({get:key=>cache.get(key)||null,put:(key,value)=>cache.set(key,value),remove:key=>cache.delete(key)})},
    LockService:{getScriptLock:()=>({tryLock:()=>{if(locked)return false;locked=true;return true;},releaseLock:()=>{locked=false;}})},
    HtmlService:{createTemplate:()=>({evaluate(){return {setTitle(){return this;},addMetaTag(){return this;}};}})},
    UrlFetchApp:{fetch(url,options={}) {
      assert.equal(locked,true,'all external fetches must be serialized'); calls++;
      if (url === 'https://rep123-seven.vercel.app/addresses.js') return response(sourceText || 'window.ADDR_DATA = '+JSON.stringify({서울:{영등포구:{당산동:[[0,0,ADDRESS,2,1,'code','서울']]}}})+';');
      if (url.startsWith('https://upload.example.net/v1/storage/upload?')) {
        const token = new URL(url).searchParams.get('id'), pending=reservations.get(token);
        assert.ok(pending); assert.equal(options.followRedirects,false);
        const blob=options.payload.Filedata; assert.ok(['image/jpeg','application/json'].includes(blob.type));
        assert.equal(blob.bytes.length,pending.size);
        const old=resources.find(r=>r.type==='file'&&r.parentId===pending.parentId&&r.name===pending.name);
        if(old){assert.equal(pending.isOverwrite,true);used-=old.size;resources.splice(resources.indexOf(old),1);}
        resources.push({...pending,bytes:blob.bytes,resourceId:'file'+(++next),type:'file',createdAt:new Date().toISOString()}); used+=blob.bytes.length;
        if(dropUploadResponse&&blob.type==='image/jpeg'){dropUploadResponse=false;throw new Error('upstream error with SECRET_SIGNED_URL');}
        return response({},201);
      }
      if (url.startsWith('https://download.example.net/v1/storage/download?')) {
        const id=new URL(url).searchParams.get('id'),file=resources.find(r=>r.resourceId===id); return response({},200,file.bytes);
      }
      const parsed=new URL(url),pathname=parsed.pathname.replace('/v1','');
      assert.equal(options.headers.Authorization,'Bearer '+props.get('MYBOX_TOKEN'));
      assert.equal(options.followRedirects,false,'PAT must never follow redirects');
      if (pathname === '/drive/storage') return response({quotaBytes:30*1024**3,usedBytes:used});
      if (/^\/drive\/resources\/[^/]+$/.test(pathname)&&options.method==='delete'){
        const id=decodeURIComponent(pathname.split('/')[3]),index=resources.findIndex(r=>r.resourceId===id);
        assert.ok(index>=0);const file=resources[index];assert.equal(file.type,'file');assert.ok(file.name.endsWith('.jpg'));
        trash.push(file);resources.splice(index,1);
        if(dropDeleteResponse){dropDeleteResponse=false;throw Error('ambiguous delete SECRET');}
        return response('',204);
      }
      if (pathname === '/drive/folders' && options.method==='post') {
        const body=JSON.parse(options.payload),folder={resourceId:'folder'+(++next),parentId:body.parentId||'',name:body.folderName,type:'folder'};
        resources.push(folder); return response(folder,201);
      }
      if (pathname === '/drive/files' && options.method==='post') {
        const body=JSON.parse(options.payload); assert.equal(body.isOverwrite,body.fileName.endsWith('.json'));
        if(failCatalog&&body.fileName.endsWith('.json'))throw Error('catalog unavailable SECRET');
        const id=String(++next); reservations.set(id,{parentId:body.parentId,name:body.fileName,size:body.fileSize,isOverwrite:body.isOverwrite});
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
  // Existing v3/v4 ownership tests also cover migration. Strict v5 capture is tested separately.
  sandbox.PHOTO_LIMITS_={...sandbox.PHOTO_LIMITS_,requireCapture};
  const login=sandbox.loginPhoto('admin',PASSWORD); assert.equal(login.ok,true);
  return {app:sandbox,props,cache,resources,trash,session:login.data.session,
    setUsed:value=>{used=value;},setLocked:value=>{locked=value;},
    dropNextUploadResponse:()=>{dropUploadResponse=true;},dropNextDeleteResponse:()=>{dropDeleteResponse=true;},failCatalog:value=>{failCatalog=value;},calls:()=>calls,
    staff(username,name='같은 이름') { const created=sandbox.manageEmployee(login.data.session,'create',{login:username,name});assert.equal(created.ok,true);const parts=new URLSearchParams(new URL(created.data.employeeLink).hash.slice(1));const result=sandbox.loginPhoto(parts.get('staff'),parts.get('key'));assert.equal(result.ok,true);return {session:result.data.session,employee:created.data.employee,code:parts.get('key'),link:created.data.employeeLink}; }};
}
module.exports={harness,fakeJpeg,ADDRESS,PASSWORD,source};
