const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const handler = require('../web/api/mybox-direct-probe.js');
const {fakeJpeg} = require('./helpers/jpeg-fixture.cjs');
const {createService,validJpeg} = require('../web/api/_lib/photo-direct-core.cjs');

function response() {
  return {statusCode:200,headers:{},body:null,
    setHeader(key,value){this.headers[key]=value;},
    status(value){this.statusCode=value;return this;},
    json(value){this.body=value;return this;}};
}
function request(action,key,extra={}) {
  return {method:'POST',headers:{'x-probe-key':key},body:{action,...extra}};
}
const ACCESS='probe-key-12';
test('diagnostic page script parses and does not embed account credentials',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../web/direct-upload-probe.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new vm.Script(script[1]));
  assert.ok(!html.includes('MYBOX_TOKEN'));
  assert.ok(!html.includes('mbx_pat_'));
});
test('direct probe is closed without both server secrets and never returns the PAT', async()=>{
  const oldToken=process.env.MYBOX_TOKEN,oldKey=process.env.MYBOX_DIRECT_PROBE_KEY;
  const oldFetch=global.fetch;let calls=0;
  try {
    delete process.env.MYBOX_TOKEN;delete process.env.MYBOX_DIRECT_PROBE_KEY;
    global.fetch=async()=>{calls++;throw Error('unexpected network');};
    const res=response();await handler(request('reserve',ACCESS,{size:1000}),res);
    assert.equal(res.statusCode,503);assert.equal(res.body.code,'SETUP_REQUIRED');assert.equal(calls,0);
  } finally {
    if(oldToken===undefined)delete process.env.MYBOX_TOKEN;else process.env.MYBOX_TOKEN=oldToken;
    if(oldKey===undefined)delete process.env.MYBOX_DIRECT_PROBE_KEY;else process.env.MYBOX_DIRECT_PROBE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});
test('MYBOX 401 is reported as a token problem without exposing the token',async()=>{
  const oldToken=process.env.MYBOX_TOKEN,oldKey=process.env.MYBOX_DIRECT_PROBE_KEY,oldFetch=global.fetch;
  process.env.MYBOX_TOKEN='fake-private-test-token';process.env.MYBOX_DIRECT_PROBE_KEY=ACCESS;
  global.fetch=async()=>({ok:false,status:401});
  try{
    const res=response();await handler(request('reserve',ACCESS,{size:123}),res);
    assert.equal(res.statusCode,502);assert.equal(res.body.code,'MYBOX_AUTH');
    assert.match(res.body.message,/MYBOX_TOKEN/);
    assert.ok(!JSON.stringify(res.body).includes('fake-private-test-token'));
  }finally{
    if(oldToken===undefined)delete process.env.MYBOX_TOKEN;else process.env.MYBOX_TOKEN=oldToken;
    if(oldKey===undefined)delete process.env.MYBOX_DIRECT_PROBE_KEY;else process.env.MYBOX_DIRECT_PROBE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});
test('authenticated probe reserves a one-use URL and cleans only its diagnostic photo', async()=>{
  const oldToken=process.env.MYBOX_TOKEN,oldKey=process.env.MYBOX_DIRECT_PROBE_KEY,oldFetch=global.fetch;
  process.env.MYBOX_TOKEN=' Bearer fake-private-test-token ';process.env.MYBOX_DIRECT_PROBE_KEY=ACCESS;
  let name='',deleted=false;
  global.fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer fake-private-test-token');
    assert.equal(options.redirect,'manual');
    const pathname=new URL(url).pathname;
    let body;
    if(pathname==='/v1/drive/resources')body={resources:[{name:'연결점검_현장방문아님',type:'folder',resourceId:'folder1'}]};
    else if(pathname==='/v1/drive/folders/folder1/resources')body={resources:name&&!deleted?[{name,type:'file',size:123,resourceId:'file1'}]:[]};
    else if(pathname==='/v1/drive/files'){
      name=JSON.parse(options.body).fileName;
      body={uploadUrl:'https://storage.example.net/v1/storage/upload?token=one-use'};
    } else if(pathname==='/v1/drive/resources/file1'){
      assert.equal(options.method,'DELETE');deleted=true;
      return {ok:true,status:204};
    } else throw Error('unexpected path '+pathname);
    return {ok:true,status:pathname==='/v1/drive/files'?201:200,text:async()=>JSON.stringify(body)};
  };
  try {
    const no=response();await handler(request('reserve','wrong-key',{size:123}),no);
    assert.equal(no.statusCode,403);assert.equal(no.body.code,'INVALID_PROBE_KEY');
    process.env.MYBOX_DIRECT_PROBE_KEY='short-key';
    const short=response();await handler(request('reserve','short-key',{size:123}),short);
    assert.equal(short.statusCode,503);assert.equal(short.body.code,'SETUP_REQUIRED');
    process.env.MYBOX_DIRECT_PROBE_KEY=ACCESS;
    const reserve=response();await handler(request('reserve',ACCESS,{size:123}),reserve);
    assert.equal(reserve.statusCode,200);assert.match(reserve.body.name,/^DIRECT_BROWSER_TEST_NOT_A_FIELD_VISIT__/);
    assert.equal(reserve.body.uploadUrl,'https://storage.example.net/v1/storage/upload?token=one-use');
    assert.ok(!JSON.stringify(reserve.body).includes('fake-private-test-token'));
    const inspect=response();await handler(request('inspect',ACCESS,{name}),inspect);
    assert.equal(inspect.body.found,true);assert.equal(inspect.body.movedToTrash,false);
    const finish=response();await handler(request('finish',ACCESS,{name}),finish);
    assert.equal(finish.body.movedToTrash,true);assert.equal(deleted,true);
    const invalid=response();await handler(request('finish',ACCESS,{name:'../field-photo.jpg'}),invalid);
    assert.equal(invalid.statusCode,400);
  } finally {
    if(oldToken===undefined)delete process.env.MYBOX_TOKEN;else process.env.MYBOX_TOKEN=oldToken;
    if(oldKey===undefined)delete process.env.MYBOX_DIRECT_PROBE_KEY;else process.env.MYBOX_DIRECT_PROBE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});
test('batch probe reserves distinct URLs and cleans only named diagnostic files',async()=>{
  const oldToken=process.env.MYBOX_TOKEN,oldKey=process.env.MYBOX_DIRECT_PROBE_KEY,oldFetch=global.fetch;
  process.env.MYBOX_TOKEN='fake-private-test-token';process.env.MYBOX_DIRECT_PROBE_KEY=ACCESS;
  const files=new Map();let created=0;
  global.fetch=async(url,options)=>{
    const pathname=new URL(url).pathname;
    let body,status=200;
    if(pathname==='/v1/drive/resources')body={resources:[{name:'연결점검_현장방문아님',type:'folder',resourceId:'folder1'}]};
    else if(pathname==='/v1/drive/folders/folder1/resources')body={resources:[...files.entries()].map(([name,id])=>({name,type:'file',size:123,resourceId:id}))};
    else if(pathname==='/v1/drive/files'){
      const name=JSON.parse(options.body).fileName,id='file'+(++created);files.set(name,id);
      body={uploadUrl:'https://storage.example.net/v1/storage/upload?token='+id};status=201;
    }else if(pathname.startsWith('/v1/drive/resources/file')){
      assert.equal(options.method,'DELETE');
      const name=[...files.entries()].find(([,id])=>pathname.endsWith('/'+id))?.[0];
      assert.ok(name);files.delete(name);return {ok:true,status:204};
    }else throw Error('unexpected path '+pathname);
    return {ok:true,status,text:async()=>JSON.stringify(body)};
  };
  try{
    const bad=response();await handler(request('reserveBatch',ACCESS,{size:123,count:101}),bad);
    assert.equal(bad.statusCode,400);assert.equal(created,0);
    const reserve=response();await handler(request('reserveBatch',ACCESS,{size:123,count:100}),reserve);
    assert.equal(reserve.statusCode,200);assert.equal(reserve.body.results.length,100);
    const names=reserve.body.results.map(item=>item.name);
    assert.equal(new Set(names).size,100);assert.ok(!JSON.stringify(reserve.body).includes('fake-private-test-token'));
    const status=response();await handler(request('statusBatch',ACCESS,{names,size:123}),status);
    assert.deepEqual(status.body.present,names);
    assert.deepEqual(status.body.mismatch,[]);
    const wrongSize=response();await handler(request('statusBatch',ACCESS,{names,size:124}),wrongSize);
    assert.deepEqual(wrongSize.body.mismatch,names);
    assert.deepEqual(wrongSize.body.present,[]);
    const finish=response();await handler(request('finishBatch',ACCESS,{names}),finish);
    assert.equal(finish.body.results.filter(item=>item.trashed).length,100);
    assert.equal(files.size,0);
    const invalid=response();await handler(request('finishBatch',ACCESS,{names:['field-photo.jpg']}),invalid);
    assert.equal(invalid.statusCode,400);
  }finally{
    if(oldToken===undefined)delete process.env.MYBOX_TOKEN;else process.env.MYBOX_TOKEN=oldToken;
    if(oldKey===undefined)delete process.env.MYBOX_DIRECT_PROBE_KEY;else process.env.MYBOX_DIRECT_PROBE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});
test('isolated lock probe requires one MYBOX folder creation to conflict and cleans the test folder',async()=>{
  const oldToken=process.env.MYBOX_TOKEN,oldKey=process.env.MYBOX_DIRECT_PROBE_KEY,oldFetch=global.fetch;
  process.env.MYBOX_TOKEN='fake-private-test-token';process.env.MYBOX_DIRECT_PROBE_KEY=ACCESS;
  const created=new Map();let next=0,deleted=0;
  global.fetch=async(url,options)=>{
    const pathname=new URL(url).pathname,method=options.method;
    if(pathname==='/v1/drive/resources')return {ok:true,status:200,text:async()=>JSON.stringify({resources:[{name:'연결점검_현장방문아님',type:'folder',resourceId:'root'}]})};
    if(pathname==='/v1/drive/folders/root/resources')return {ok:true,status:200,text:async()=>JSON.stringify({resources:[{name:'직접전송_잠금점검',type:'folder',resourceId:'parent'}]})};
    if(pathname==='/v1/drive/folders/parent/resources')return {ok:true,status:200,text:async()=>JSON.stringify({resources:[...created.entries()].map(([name,id])=>({name,type:'folder',resourceId:id}))})};
    if(pathname==='/v1/drive/folders'&&method==='POST'){
      const body=JSON.parse(options.body);assert.equal(body.parentId,'parent');
      if(created.has(body.folderName))return {ok:false,status:409};
      const id='test'+(++next);created.set(body.folderName,id);
      return {ok:true,status:201,text:async()=>JSON.stringify({resourceId:id})};
    }
    if(pathname.startsWith('/v1/drive/resources/test')&&method==='DELETE'){
      for(const [name,id] of created)if(pathname.endsWith('/'+id))created.delete(name);
      deleted++;return {ok:true,status:204};
    }
    throw Error('unexpected path '+pathname);
  };
  try{const res=response();await handler(request('lockCheck',ACCESS),res);
    assert.equal(res.statusCode,200);assert.equal(res.body.atomic,true);
    assert.deepEqual(res.body.statuses.sort(),[201,409]);assert.equal(deleted,1);assert.equal(created.size,0);
  }finally{
    if(oldToken===undefined)delete process.env.MYBOX_TOKEN;else process.env.MYBOX_TOKEN=oldToken;
    if(oldKey===undefined)delete process.env.MYBOX_DIRECT_PROBE_KEY;else process.env.MYBOX_DIRECT_PROBE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});

test('pipeline probe accepts MYBOX move HTTP 200 with an empty body and cleans test files',async()=>{
  const oldToken=process.env.MYBOX_TOKEN,oldKey=process.env.MYBOX_DIRECT_PROBE_KEY,oldFetch=global.fetch;
  process.env.MYBOX_TOKEN='fake-private-test-token';process.env.MYBOX_DIRECT_PROBE_KEY=ACCESS;
  const name='DIRECT_BROWSER_TEST_NOT_A_FIELD_VISIT__12345678-1234-1234-1234-123456789abc.jpg';
  const files=new Map([['photo',{resourceId:'photo',parentId:'root',name,type:'file',bytes:fakeJpeg()}]]);
  let folder=false,deleted=0,moved=false;const seen=[];
  const list=parent=>[...files.values()].filter(file=>file.parentId===parent)
    .map(file=>({resourceId:file.resourceId,parentId:file.parentId,name:file.name,type:'file',size:file.bytes.length}));
  global.fetch=async(url,options={})=>{
    const parsed=new URL(url),pathname=parsed.pathname,method=options.method||'GET';seen.push(method+' '+pathname);
    if(parsed.hostname==='storage.test'){
      const id=parsed.searchParams.get('id');
      if(pathname.endsWith('/download'))return new Response(files.get(id).bytes);
      if(pathname.endsWith('/upload')){
        const bytes=Buffer.from(await options.body.get('Filedata').arrayBuffer());
        files.set('index',{resourceId:'index',parentId:'dest',name:parsed.searchParams.get('name'),type:'file',bytes});
        return new Response('',{status:201});
      }
    }
    if(pathname==='/v1/drive/resources')return Response.json({resources:[{name:'연결점검_현장방문아님',type:'folder',resourceId:'root'}]});
    if(pathname==='/v1/drive/folders/root/resources')return Response.json({resources:[
      ...(folder?[{name:'직접전송_저장단계점검',type:'folder',resourceId:'dest'}]:[]),...list('root')]});
    if(pathname==='/v1/drive/folders/dest/resources')return Response.json({resources:list('dest')});
    if(pathname==='/v1/drive/folders'&&method==='POST'){folder=true;return Response.json({resourceId:'dest'},{status:201});}
    if(pathname==='/v1/drive/files/photo/download'||pathname==='/v1/drive/files/index/download')
      return Response.json({downloadUrl:'https://storage.test/v1/storage/download?id='+pathname.split('/')[4]});
    if(pathname==='/v1/drive/resources/photo/rename'&&method==='POST'){
      files.get('photo').name=JSON.parse(options.body).name;
      return Response.json({name:files.get('photo').name});
    }
    if(pathname==='/v1/drive/resources/photo/move'&&method==='POST'){
      assert.equal(JSON.parse(options.body).parentId,'dest');files.get('photo').parentId='dest';moved=true;
      return {ok:true,status:200,text:async()=>''};
    }
    if(pathname==='/v1/drive/files'&&method==='POST'){
      const body=JSON.parse(options.body);
      return Response.json({uploadUrl:'https://storage.test/v1/storage/upload?id=index&name='+encodeURIComponent(body.fileName)},{status:201});
    }
    if(pathname==='/v1/drive/resources/photo'||pathname==='/v1/drive/resources/index'){
      assert.equal(method,'DELETE');files.delete(pathname.split('/')[4]);deleted++;return new Response(null,{status:204});
    }
    throw Error('unexpected path '+pathname);
  };
  try{
    const bytes=await createService({token:'fake-private-test-token'}).readBytes({resourceId:'photo',size:fakeJpeg().length});
    assert.doesNotThrow(()=>validJpeg(bytes));
    const res=response();await handler(request('pipelineCheck',ACCESS,{name}),res);
    assert.equal(res.statusCode,200,JSON.stringify({body:res.body,seen}));
    assert.equal(res.body.passed,true);assert.equal(res.body.indexVerified,true);
    assert.equal(res.body.trashed,2);assert.equal(deleted,2);assert.equal(moved,true);assert.equal(files.size,0);
  }finally{
    if(oldToken===undefined)delete process.env.MYBOX_TOKEN;else process.env.MYBOX_TOKEN=oldToken;
    if(oldKey===undefined)delete process.env.MYBOX_DIRECT_PROBE_KEY;else process.env.MYBOX_DIRECT_PROBE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});
