const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createService,source,validJpeg}=require('../web/api/_lib/photo-direct-core.cjs');
const {fakeJpeg}=require('./helpers/jpeg-fixture.cjs');

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const key='a'.repeat(64),other='b'.repeat(64),address=source().map.keys().next().value;
const anotherAddress=[...source().map.keys()].find(value=>digest(value)[0]!==digest(address)[0]);
const now=Date.parse('2026-10-20T06:00:00.000Z');

function fakeMybox(){
  const entries=new Map(),uploads=new Map();let next=0;
  const response=(value,status=200)=>Response.json(value,{status});
  const list=parent=>[...entries.values()].filter(x=>x.parent===parent).map(({id,parent,name,type,size,createdAt})=>
    ({resourceId:id,parentId:parent,name,type,size,createdAt}));
  async function fetcher(url,options={}){
    const route=new URL(url),path=route.pathname,method=options.method||'GET';
    if(route.hostname==='storage.test'){
      const id=route.searchParams.get('file'),entry=entries.get(id);
      if(path.endsWith('/upload')&&method==='POST'){
        if(!uploads.has(id))return response({error:'invalid'},404);
        const file=options.body.get('Filedata'),bytes=Buffer.from(await file.arrayBuffer()),pending=uploads.get(id);
        if(bytes.length!==pending.size)return response({error:'size'},400);
        const prior=list(pending.parent).find(f=>f.name===pending.name);
        if(prior){if(!pending.overwrite)return response({error:'duplicate'},409);entries.delete(prior.resourceId);}
        entries.set(id,{id,parent:pending.parent,name:pending.name,type:'file',size:bytes.length,
          bytes,createdAt:new Date(now).toISOString()});uploads.delete(id);return response({resourceId:id});
      }
      if(path.endsWith('/download')&&entry?.type==='file')return new Response(entry.bytes);
      return response({error:'not found'},404);
    }
    if(path==='/v1/drive/storage')return response({quotaBytes:30000000000,usedBytes:[...entries.values()].reduce((n,e)=>n+(e.size||0),0)});
    if(path==='/v1/drive/resources'&&method==='GET')return response({resources:list('')});
    let match=path.match(/^\/v1\/drive\/folders\/([^/]+)\/resources$/);
    if(match&&method==='GET')return response({resources:list(decodeURIComponent(match[1]))});
    if(path==='/v1/drive/folders'&&method==='POST'){
      const body=JSON.parse(options.body),parent=body.parentId||'';
      if(list(parent).some(x=>x.name===body.folderName))return response({error:'exists'},409);
      const id=String(++next);entries.set(id,{id,parent,name:body.folderName,type:'folder',size:0,
        createdAt:new Date(now).toISOString()});return response({resourceId:id});
    }
    if(path==='/v1/drive/files'&&method==='POST'){
      const body=JSON.parse(options.body),id=String(++next);
      uploads.set(id,{parent:body.parentId,name:body.fileName,size:body.fileSize,overwrite:body.isOverwrite});
      return response({uploadUrl:'https://storage.test/v1/storage/upload?file='+id});
    }
    match=path.match(/^\/v1\/drive\/files\/([^/]+)\/download$/);
    if(match&&method==='GET'){
      const id=decodeURIComponent(match[1]);if(!entries.has(id))return response({error:'not found'},404);
      return response({downloadUrl:'https://storage.test/v1/storage/download?file='+id});
    }
    match=path.match(/^\/v1\/drive\/resources\/([^/]+)(?:\/(rename|move))?$/);
    if(match){
      const id=decodeURIComponent(match[1]),entry=entries.get(id);
      if(!entry)return response({error:'not found'},404);
      if(method==='DELETE'){entries.delete(id);for(const child of list(id))entries.delete(child.resourceId);return new Response(null,{status:204});}
      const body=JSON.parse(options.body||'{}');
      if(match[2]==='rename'&&method==='POST'){
        if(list(entry.parent).some(x=>x.name===body.name&&x.resourceId!==id))return response({error:'exists'},409);
        entry.name=body.name;return response({resourceId:id});
      }
      if(match[2]==='move'&&method==='POST'){
        if(list(body.parentId).some(x=>x.name===entry.name))return response({error:'exists'},409);
        entry.parent=body.parentId;return new Response(null,{status:200});
      }
    }
    throw Error('Unhandled fake MYBOX route '+method+' '+url);
  }
  return {entries,fetcher,list};
}
function fixture(){const box=fakeMybox(),service=createService({token:'test-secret',adminPassword:'secure-admin-passphrase',fetcher:box.fetcher,now:()=>now});
  return {box,service};}
test('storage safety margin follows the actual MYBOX quota without a 24 GB ceiling',async()=>{
  const quotaAt=async(quotaBytes,usedBytes)=>createService({token:'test-secret',
    fetcher:async()=>Response.json({quotaBytes,usedBytes})}).quota();
  assert.deepEqual(await quotaAt(30000000000,28999800000),
    {canUpload:true,usedBytes:28999800000,remainingSafeBytes:200000});
  assert.deepEqual(await quotaAt(30000000000,29000000000),
    {canUpload:false,usedBytes:29000000000,remainingSafeBytes:0});
  assert.deepEqual(await quotaAt(15000000000,13999800000),
    {canUpload:true,usedBytes:13999800000,remainingSafeBytes:200000});
});
async function uploadOne(ctx,deviceKey,seed=1,where=address){
  const bytes=fakeJpeg(seed),hash=digest(bytes),capture=await ctx.service.capture(where,deviceKey);
  const reservation=await ctx.service.reserve({address:where,deviceKey,hash,size:bytes.length,visitDate:'2026-10-20',
    captureTicket:capture.ticket,capturedAt:now,consent:true});
  assert.ok(reservation.uploadUrl);const form=new FormData();form.append('Filedata',new Blob([bytes],{type:'image/jpeg'}),'pending.jpg');
  assert.equal((await ctx.box.fetcher(reservation.uploadUrl,{method:'POST',body:form})).status,200);
  return ctx.service.finish({reservation:reservation.reservation,deviceKey});
}

test('direct upload stores, confirms, indexes and enforces two address slots',async()=>{
  const ctx=fixture(),one=await uploadOne(ctx,key,1),two=await uploadOne(ctx,other,2);
  assert.equal(one.saved,true);assert.equal(one.count,1);assert.equal(two.count,2);
  assert.equal((await ctx.service.status(address,key)).photos.length,2);
  assert.equal((await ctx.service.receipt(address,key,digest(fakeJpeg(1)))).saved,true);
  assert.equal((await ctx.service.receipt(address,other,digest(fakeJpeg(1)))).saved,false);
  assert.deepEqual((await ctx.service.completionChunk(digest(address)[0])).addresses,[address]);
  assert.equal((await ctx.service.overview()).photos,2);
  await assert.rejects(uploadOne(ctx,key,3),e=>e.code==='FULL');
});

test('only uploading device or administrator can delete a photo',async()=>{
  const ctx=fixture(),saved=await uploadOne(ctx,key);
  await assert.rejects(ctx.service.remove({address,photoId:saved.photo.id,deviceKey:other}),e=>e.code==='FORBIDDEN');
  const login=ctx.service.adminLogin('secure-admin-passphrase');ctx.service.requireAdmin(login.session);
  await assert.rejects(Promise.resolve().then(()=>ctx.service.requireAdmin('invalid')),e=>e.code==='TICKET');
  const removed=await ctx.service.remove({address,photoId:saved.photo.id,admin:true});
  assert.equal(removed.deleted,true);assert.equal((await ctx.service.status(address,key)).totalCount,0);
  assert.equal((await ctx.service.overview()).photos,0);
});

test('server verifies bytes and rejects wrong hash without consuming a slot',async()=>{
  const ctx=fixture(),bytes=fakeJpeg(1),capture=await ctx.service.capture(address,key);
  const reserved=await ctx.service.reserve({address,deviceKey:key,hash:'0'.repeat(64),size:bytes.length,
    visitDate:'2026-10-20',captureTicket:capture.ticket,capturedAt:now,consent:true});
  const form=new FormData();form.append('Filedata',new Blob([bytes],{type:'image/jpeg'}),'pending.jpg');
  await ctx.box.fetcher(reserved.uploadUrl,{method:'POST',body:form});
  await assert.rejects(ctx.service.finish({reservation:reserved.reservation,deviceKey:key}),e=>e.code==='HASH');
  assert.equal((await ctx.service.status(address,key)).totalCount,0);
});

test('different addresses accept concurrent photos without leaving a catalog update pending',async()=>{
  const ctx=fixture(),[first,second]=await Promise.all([
    uploadOne(ctx,key,1,address),uploadOne(ctx,other,2,anotherAddress)]);
  assert.equal(first.saved,true);assert.equal(second.saved,true);
  assert.equal(first.catalogPending,false);assert.equal(second.catalogPending,false);
  assert.equal((await ctx.service.status(address,key)).totalCount,1);
  assert.equal((await ctx.service.status(anotherAddress,other)).totalCount,1);
  let overview=await ctx.service.overview();
  if(overview.pending){
    const repaired=await ctx.service.repairPending(10);assert.equal(repaired.remaining,0);
    overview=await ctx.service.overview();
  }
  assert.equal(overview.photos,2);assert.equal(overview.addresses,2);
});

test('JPEG validator rejects zero dimensions and metadata',()=>{
  const bytes=fakeJpeg();assert.doesNotThrow(()=>validJpeg(bytes));
  const broken=Buffer.from(bytes);broken[7]=0;broken[8]=0;
  assert.throws(()=>validJpeg(broken),e=>e.code==='JPEG');
  const metadata=Buffer.concat([Buffer.from([255,216,255,225,0,4,0,0]),bytes.subarray(2)]);
  assert.throws(()=>validJpeg(metadata),e=>e.code==='METADATA');
});
