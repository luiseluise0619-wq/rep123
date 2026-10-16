const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../photo-backend/Photo.html'), 'utf8');
const script = html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)[1].replace('initialize().catch(handle);','');

function harness({blockedStorage = false, reply} = {}) {
  const elements = new Map(), local = new Map(), tab = new Map(), delays = [], calls = [], revoked = [], listeners = {};
  function element() {
    return {textContent:'',value:'',checked:false,disabled:false,hidden:false,children:[],style:{},
      classList:{toggle(){}},append(...values){this.children.push(...values);},appendChild(value){this.children.push(value);},
      prepend(value){this.children.unshift(value);},replaceChildren(...values){this.children=values;},
      setAttribute(){},removeAttribute(){},remove(){},close(){this.open=false;},showModal(){this.open=true;},reportValidity(){return !!this.value;}};
  }
  const get = id => {if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  get('initial').textContent=JSON.stringify({address:'서울특별시 영등포구 당산동 1가 1',maxBytes:200000,maxEdge:1600});
  const storage = map => ({getItem:key=>{if(blockedStorage)throw Error('blocked');return map.get(key)||null;},
    setItem:(key,value)=>{if(blockedStorage)throw Error('blocked');map.set(key,value);},removeItem:key=>{if(blockedStorage)throw Error('blocked');map.delete(key);}});
  let success, failure;
  const runner = new Proxy({}, {get(target,name) {
    if(name==='withSuccessHandler')return fn=>{success=fn;return runner;};
    if(name==='withFailureHandler')return fn=>{failure=fn;return runner;};
    return (...args)=>{calls.push({name,args}); const ok=success,fail=failure;
      Promise.resolve().then(()=>reply ? reply(name,args,calls) : {ok:true,data:{}}).then(ok,fail);};
  }});
  const window = {localStorage:storage(local),sessionStorage:storage(tab),addEventListener:(name,fn)=>{listeners[name]=fn;},google:{script:{run:runner}}};
  const context = vm.createContext({window,google:window.google,document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},
    Date,Intl,JSON,Math,Promise,Error,Number,String,Array,URLSearchParams,URL:{revokeObjectURL:url=>revoked.push(url)},
    setTimeout:(callback,delay)=>{delays.push(delay);callback();}});
  vm.runInContext(script,context);
  return {context,get,local,tab,calls,delays,revoked,listeners,run:code=>vm.runInContext(code,context)};
}

test('UI starts even when all browser storage is blocked; keeps a memory session',()=>{
  const h=harness({blockedStorage:true});
  assert.equal(h.run("saveSession('signed-test',true)"),false);
  h.run("session='signed-test'");
  assert.equal(h.run('session'),'signed-test');
  assert.equal(h.get('remember').checked,false,'remember must be opt-in');
});

test('remember stores only a signed token for eight hours; logout clears both stores and zoom',()=>{
  const h=harness();
  assert.equal(h.run("saveSession('signed-test',true)"),true);
  const record=JSON.parse(h.local.get('photoSessionV3_8h'));
  assert.deepEqual(Object.keys(record).sort(),['expiresAt','token']);
  assert.ok(record.expiresAt-Date.now()<=8*3600000);
  assert.equal(h.run('rememberedSession()'),'signed-test');
  h.run("session='signed-test'; logout()");
  assert.equal(h.local.size,0); assert.equal(h.tab.size,0); assert.equal(h.run('session'),'');
  assert.equal(h.get('photoZoom').open,false);
  h.local.set('photoSessionV3_8h',JSON.stringify({token:'expired',expiresAt:Date.now()-1}));
  assert.equal(h.run('rememberedSession()'),'');
});

test('only BUSY receives bounded automatic retries, never ambiguous upload failures',async()=>{
  const h=harness({reply:(name,args,calls)=>calls.length<3 ? {ok:false,code:'BUSY',message:'busy'} : {ok:true,data:{saved:true}}});
  assert.equal((await h.run("rpc('uploadPhoto','signed','address',{})")).saved,true);
  assert.equal(h.calls.length,3); assert.equal(h.delays.length,2);
  assert.ok(h.delays[0]>=1500 && h.delays[0]<2000);
  const blocked=harness({reply:()=>({ok:false,code:'BUSY',message:'busy'})});
  await assert.rejects(blocked.run("rpc('getStatus')"),/busy/);
  assert.equal(blocked.calls.length,5);
  const network=harness({reply:()=>{throw Error('disconnected');}});
  await assert.rejects(network.run("rpc('uploadPhoto')"),/연결이 끊기/);
  assert.equal(network.calls.length,1);
});

test('selection can be removed individually and appends without losing a prior photo',async()=>{
  const h=harness();
  h.run("canUpload=true; compress=async file=>({url:file.name,blob:{size:100},originalSize:1000,width:100,height:100})");
  h.get('files').files=[{name:'one'}]; await h.get('files').onchange();
  h.get('files').files=[{name:'two'}]; await h.get('files').onchange();
  assert.equal(h.run('pending.length'),2); assert.equal(h.get('choose').disabled,true);
  h.get('preview').children[0].children[3].onclick();
  assert.equal(h.run('pending.length'),1); assert.equal(h.run('pending[0].url'),'two');
  assert.deepEqual(h.revoked,['one']); assert.equal(h.get('readable').checked,false);
  assert.equal(h.get('choose').disabled,false);
});

test('partial upload keeps only unsaved selection; ambiguous retry is left to user',async()=>{
  let uploaded=0;
  const h=harness({reply:name=>{
    if(name==='uploadPhoto')return ++uploaded===1 ? {ok:true,data:{alreadySaved:false}} : {ok:false,code:'UPLOAD',message:'확인 필요'};
    return {ok:true,data:{ready:true,authenticated:true,name:'테스트',photos:[{slot:1,bytes:100,visitDate:'2026-01-01',uploader:'테스트'}],quota:{canUpload:true,usedBytes:100,remainingSafeBytes:1000}}};
  }});
  h.run("session='signed'; canUpload=true; pending=[{url:'one',blob:{}},{url:'two',blob:{}}]; base64=async()=>''");
  h.get('readable').checked=true; h.get('visitDate').value='2026-01-01'; h.run('updateControls()');
  await h.get('upload').onclick();
  assert.equal(uploaded,2); assert.equal(h.run('pending.length'),1); assert.equal(h.run('pending[0].url'),'two');
  assert.equal(h.get('preview').children.length,1); assert.equal(h.run('busy'),false);
  assert.equal(h.get('message').textContent,'확인 필요');
});

test('stale status response after logout cannot reopen protected workspace',async()=>{
  let finish;
  const h=harness({reply:()=>new Promise(resolve=>{finish=resolve;})});
  h.run("session='signed'"); const refresh=h.run('refresh()');
  await Promise.resolve(); h.run('logout()');
  finish({ok:true,data:{ready:true,authenticated:true,photos:[],quota:{canUpload:true}}}); await refresh;
  assert.equal(h.get('workspace').hidden,true);
});

test('private entry accepts only a staff ID and a 16-character random key in the fragment',()=>{
  const h=harness();
  assert.equal(h.run("parseStaffHash('#staff=staff01&key=abcdefghijklmnop').login"),'staff01');
  for(const hash of ['#staff=admin&key=abcdefghijklmnop','#staff=staff01&key=short','?staff=staff01&key=abcdefghijklmnop','#staff=<script>&key=abcdefghijklmnop']) {
    assert.equal(h.run('parseStaffHash('+JSON.stringify(hash)+')'),null);
  }
});

test('timestamp footer preserves the whole original and distinguishes device time from entered visit date',()=>{
  const h=harness(),draws=[],texts=[];
  const canvas={getContext:()=>({measureText:s=>({width:s.length*8}),fillRect(){},drawImage:(...args)=>draws.push(args),fillText:(...args)=>texts.push(args)})};
  h.context.document.createElement=()=>canvas;
  h.run("stampImage({naturalWidth:3000,naturalHeight:2000},'서울특별시 영등포구 당산동1가 256-119','2026-10-15',new Date('2026-10-16T00:00:00Z'))");
  assert.equal(canvas.width,1600); assert.ok(canvas.height>1067);
  assert.deepEqual(draws[0].slice(1),[0,0,1600,1067]);
  assert.match(texts[0][0],/앱 기록\(KST·기기 시각\): 2026-10-16 09:00:00/);
  assert.equal(texts[1][0],'방문일(직접 입력): 2026-10-15');
  assert.ok(texts.some(row=>row[0].includes('당산동1가 256-119')));
  assert.ok(texts.every(row=>row[2]>1067),'footer must not cover original pixels');
});
