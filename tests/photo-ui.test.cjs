const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto=require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '../photo-backend/Photo.html'), 'utf8');
const script = html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)[1].replace('initialize().catch(handle);','');

function harness({blockedStorage = false, reply,storedKey} = {}) {
  const elements = new Map(), local = new Map(), tab = new Map(), delays = [], calls = [], revoked = [], listeners = {};
  if(storedKey)local.set('photoDeviceKeyV4',storedKey);
  function element() {
    return {textContent:'',value:'',checked:false,disabled:false,hidden:false,children:[],style:{},
      classList:{toggle(){}},append(...values){this.children.push(...values);},appendChild(value){this.children.push(value);},
      prepend(value){this.children.unshift(value);},replaceChildren(...values){this.children=values;},
      focus(){},setAttribute(){},removeAttribute(){},remove(){},close(){this.open=false;},showModal(){this.open=true;},reportValidity(){return !!this.value;}};
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
  const window = {crypto:crypto.webcrypto,confirm:()=>true,localStorage:storage(local),sessionStorage:storage(tab),addEventListener:(name,fn)=>{listeners[name]=fn;},google:{script:{run:runner}}};
  const context = vm.createContext({window,google:window.google,document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},
    Date,Intl,JSON,Math,Promise,Error,Number,String,Array,URLSearchParams,URL:{revokeObjectURL:url=>revoked.push(url)},
    setTimeout:(callback,delay)=>{delays.push(delay);callback();}});
  vm.runInContext(script,context);
  return {context,get,local,tab,calls,delays,revoked,listeners,run:code=>vm.runInContext(code,context)};
}

test('every directly referenced control exists in the delivered HTML',()=>{
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  assert.equal(ids.size,[...html.matchAll(/\bid="([^"]+)"/g)].length,'HTML IDs must be unique');
  for(const match of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.has(match[1]),'missing control: '+match[1]);
});

test('blocked browser storage permits viewing but does not create a disposable upload/delete identity',async()=>{
  const h=harness({blockedStorage:true});
  assert.equal(h.run('deviceKey'),'');
  assert.match(h.get('deviceNotice').textContent,/보기만/);
  h.run('canUpload=false;updateControls()');assert.equal(h.get('choose').disabled,true);
});

test('a secure random deletion key persists only in this browser and survives reopening',()=>{
  const h=harness();
  const key=h.run('deviceKey');assert.match(key,/^[0-9a-f]{64}$/);
  assert.equal(h.local.get('photoDeviceKeyV4'),key);assert.equal(h.local.size,1);assert.equal(h.tab.size,0);
  assert.equal(harness({storedKey:key}).run('deviceKey'),key);
  assert.notEqual(harness().run('deviceKey'),key);
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
    if(name==='uploadPublicPhoto')return ++uploaded===1 ? {ok:true,data:{alreadySaved:false}} : {ok:false,code:'UPLOAD',message:'확인 필요'};
    return {ok:true,data:{ready:true,authenticated:true,name:'테스트',photos:[{slot:1,bytes:100,visitDate:'2026-01-01',uploader:'테스트'}],quota:{canUpload:true,usedBytes:100,remainingSafeBytes:1000}}};
  }});
  h.run("canUpload=true; pending=[{url:'one',blob:{}},{url:'two',blob:{}}]; base64=async()=>''");
  h.get('readable').checked=true; h.get('visitDate').value='2026-01-01'; h.run('updateControls()');
  await h.get('upload').onclick();
  assert.equal(uploaded,2); assert.equal(h.run('pending.length'),1); assert.equal(h.run('pending[0].url'),'two');
  assert.equal(h.get('preview').children.length,1); assert.equal(h.run('busy'),false);
  assert.equal(h.get('message').textContent,'확인 필요');
});

test('a stale status response cannot replace a newly selected address',async()=>{
  let finish;
  const h=harness({reply:()=>new Promise(resolve=>{finish=resolve;})});
  h.get('workspace').hidden=true;const refresh=h.run('refresh()');
  await Promise.resolve();h.run("currentAddress='new selected address';viewEpoch++");
  finish({ok:true,data:{ready:true,authenticated:true,photos:[],quota:{canUpload:true}}}); await refresh;
  assert.equal(h.get('workspace').hidden,true);
});

test('only server-marked own photos have a delete control; user confirmation precedes deletion',async()=>{
  const h=harness({reply:()=>({ok:true,data:{ready:true,totalCount:0,photos:[],quota:{canUpload:true}}})});
  const other=h.run("photoCard({id:'a'.repeat(64),slot:1,bytes:100,canDelete:false})");
  assert.equal(other.children.some(c=>c.textContent==='내 사진 삭제'),false);
  const own=h.run("photoCard({id:'a'.repeat(64),slot:1,bytes:100,canDelete:true})");
  const remove=own.children.at(-2),confirmation=own.children.at(-1);
  remove.onclick();assert.equal(h.calls.length,0);assert.equal(confirmation.hidden,false);
  confirmation.children.at(-1).onclick();assert.equal(confirmation.hidden,true);assert.equal(h.calls.length,0);
  remove.onclick();await confirmation.children[1].onclick();
  assert.equal(h.calls[0].name,'deletePhoto');assert.equal(h.calls[0].args[0],'');assert.equal(h.calls[0].args[1],h.run('deviceKey'));
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

test('upload actions appear only after selection, and changing address cannot discard pending photos',()=>{
  const h=harness();h.run('canUpload=true;updateControls()');
  assert.equal(h.get('saveBar').hidden,true);assert.equal(h.get('reviewBlock').hidden,true);
  h.run("pending=[{url:'one',blob:{size:100}}];updateControls()");
  assert.equal(h.get('saveBar').hidden,false);assert.equal(h.get('reviewBlock').hidden,false);assert.equal(h.get('changeAddress').disabled,true);
  h.run('clearPending()');assert.equal(h.get('saveBar').hidden,true);assert.equal(h.get('changeAddress').disabled,false);
});
test('address picker is folded for a supplied address and the map is initialized only on demand',()=>{
  const h=harness();let created=0;
  h.context.window.ADDR_DATA={서울:{영등포구:{당산동:[[37,127,'서울특별시 영등포구 당산동 1가 1']]}}};
  h.context.window.L={map:()=>{created++;return {setView(){return this;},invalidateSize(){}};},tileLayer:()=>({addTo(){}}),marker:()=>({remove(){},addTo(){return this;},bindPopup(){return this;},openPopup(){return this;}})};
  h.run('initPicker()');assert.equal(created,0);assert.equal(h.get('pickAddress').hidden,true);
  h.get('mapDetails').open=true;h.get('mapDetails').ontoggle();assert.equal(created,1);
  h.get('mapDetails').ontoggle();assert.equal(created,1,'reopening must reuse the map');
});

test('changing address keeps a reloadable link without including the browser deletion key',async()=>{
  const h=harness({reply:()=>({ok:true,data:{ready:true,totalCount:0,photos:[],quota:{canUpload:true}}})});
  let updated;
  h.context.google.script.history={replace:(state,params,fragment)=>{updated={state,params,fragment};}};
  await h.run("chooseAddress([37,127,'서울특별시 영등포구 당산동1가 14-2'])");
  assert.equal(h.get('address').textContent,'서울특별시 영등포구 당산동1가 14-2');
  assert.equal(updated.params.address,h.get('address').textContent);
  assert.deepEqual(Object.keys(updated.params).sort(),['address','build']);
  assert.ok(!JSON.stringify(updated).includes(h.run('deviceKey')));
  assert.equal(h.get('pickAddress').hidden,true);
});
