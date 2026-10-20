const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const handler = require('../web/api/mybox-direct-probe.js');

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
    return {ok:true,status:pathname==='/v1/drive/files'?201:200,json:async()=>body};
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
    return {ok:true,status,json:async()=>body};
  };
  try{
    const bad=response();await handler(request('reserveBatch',ACCESS,{size:123,count:101}),bad);
    assert.equal(bad.statusCode,400);assert.equal(created,0);
    const reserve=response();await handler(request('reserveBatch',ACCESS,{size:123,count:100}),reserve);
    assert.equal(reserve.statusCode,200);assert.equal(reserve.body.results.length,100);
    const names=reserve.body.results.map(item=>item.name);
    assert.equal(new Set(names).size,100);assert.ok(!JSON.stringify(reserve.body).includes('fake-private-test-token'));
    const status=response();await handler(request('statusBatch',ACCESS,{names}),status);
    assert.deepEqual(status.body.present,names);
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
