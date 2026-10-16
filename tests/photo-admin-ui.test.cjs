const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../photo-backend/Admin.html'),'utf8');
const script=html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)[1].replace('openAdmin().catch(handle);','');
function harness(reply=()=>({ok:true,data:{}}),timers={setTimeout,clearTimeout}){
  const elements=new Map(),calls=[],local=new Map(),tab=new Map();
  function element(){return {textContent:'',value:'',checked:false,disabled:false,hidden:false,children:[],style:{},classList:{toggle(){}},
    append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;},addEventListener(){},removeAttribute(){},close(){this.open=false;},showModal(){this.open=true;}};}
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  get('initial').textContent='{}';
  const storage=map=>({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
  let success,failure;
  const runner=new Proxy({},{get(target,name){if(name==='withSuccessHandler')return fn=>{success=fn;return runner;};if(name==='withFailureHandler')return fn=>{failure=fn;return runner;};return (...args)=>{calls.push({name,args});const ok=success,fail=failure;Promise.resolve().then(()=>reply(name,args)).then(ok,fail);};}});
  const window={google:{script:{run:runner}},localStorage:storage(local),sessionStorage:storage(tab),addEventListener(){},confirm:()=>true};
  const context=vm.createContext({window,google:window.google,document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},Date,JSON,Math,Number,String,Array,Promise,Error,...timers});
  vm.runInContext(script,context);
  return {get,calls,run:code=>vm.runInContext(code,context)};
}
test('staff identity never opens the administrator workspace or requests the catalog',async()=>{
  const h=harness(()=>({ok:true,data:{ready:true,authenticated:true,role:'staff'}}));h.run("session='staff-session'");await h.run('refresh()');
  assert.equal(h.get('workspace').hidden,true);assert.equal(h.run('session'),'');
  assert.deepEqual(h.calls.map(c=>c.name),['getStatus']);
});
test('logout before staff-link issuance reply cannot display a stale private link',async()=>{
  let finish;
  const h=harness(()=>new Promise(resolve=>{finish=resolve;}));h.run("session='admin-session'");
  const pending=h.get('createForm').onsubmit({preventDefault(){}});await Promise.resolve();h.run('logout()');
  finish({ok:true,data:{employee:{name:'test',login:'staff01'},employeeLink:'https://example.invalid/#staff=staff01&key=fake'}});await pending;
  assert.equal(h.get('linkDialog').open,false);assert.equal(h.get('linkValue').value,'');assert.equal(h.get('workspace').hidden,true);
});
test('CSV cells quote content and neutralize spreadsheet formulas',()=>{
  const h=harness();
  assert.equal(h.run("csvCell('=HYPERLINK(\"bad\")')"),'"\'=HYPERLINK(""bad"")"');
  assert.equal(h.run("csvCell('서울, 주소')"),'"서울, 주소"');
});
test('ending a busy operation does not enable pagination beyond the last page',()=>{
  const h=harness();h.run('controls(false)');
  assert.equal(h.get('prev').disabled,true);assert.equal(h.get('next').disabled,true);
});
test('administrator deletion requires inline confirmation and sends the exact displayed photo ID',async()=>{
  const h=harness(name=>({ok:true,data:name==='deletePhoto'?{deleted:true}:name==='getStatus'?{ready:true,authenticated:true,role:'admin'}:{addresses:0,photos:0,legacy:0,pending:0,chunks:[],updatedAt:null,scan:{active:false},scanComplete:true,quota:{usedBytes:0,remainingSafeBytes:24000000000}}}));
  h.run("session='admin-session';selectedPhoto={address:'test source address',id:'a'.repeat(64)}");
  h.get('deletePhoto').onclick();assert.equal(h.calls.length,0);assert.equal(h.get('deleteConfirm').hidden,false);
  h.get('cancelDelete').onclick();assert.equal(h.get('deleteConfirm').hidden,true);
  h.get('deletePhoto').onclick();await h.get('confirmDelete').onclick();
  assert.equal(h.calls[0].name,'deletePhoto');assert.deepEqual(Array.from(h.calls[0].args),['admin-session','','test source address','a'.repeat(64)]);
  assert.equal(h.run('selectedPhoto'),null);assert.equal(h.get('photoDialog').open,false);
});

const overview=(extra={})=>({addresses:1,photos:1,legacy:0,pending:0,chunks:['a'],updatedAt:'2026-10-16T04:00:00Z',scan:{active:false},scanComplete:true,quota:{usedBytes:1,remainingSafeBytes:24000000000},...extra});
const row={address:'test source address',province:'서울',district:'동대문구',dong:'이문2동',photos:[{slot:1,uploadedAt:'2026-10-16T04:00:00Z'}]};
const identity={ready:true,authenticated:true,role:'admin'};

test('one refresh checks MYBOX to completion then updates both totals and address rows',async()=>{
  let steps=0;
  const h=harness(name=>({ok:true,data:name==='getStatus'?identity:name==='getAdminOverview'?overview():name==='syncAdminCatalog'?{scan:{active:++steps===1,processed:steps,issues:0},pending:0}:{rows:[row]}}));
  h.run("session='admin-session'");h.get('province').value='서울';await h.get('refresh').onclick();
  assert.deepEqual(h.calls.map(c=>c.name),['getStatus','getAdminOverview','syncAdminCatalog','syncAdminCatalog','getStatus','getAdminOverview','getAdminChunk']);
  assert.deepEqual(h.calls.filter(c=>c.name==='syncAdminCatalog').map(c=>c.args[1]),[true,false]);
  assert.equal(h.get('photoCount').textContent,'1');assert.equal(h.run('rows.length'),1);
  assert.equal(h.get('province').value,'서울');assert.equal(h.get('refresh').disabled,false);
  assert.equal(h.get('refresh').textContent,'새로고침');assert.equal(h.get('stopSync').hidden,true);
  assert.match(h.get('message').textContent,/수량과 목록을 새로/);
  assert.doesNotMatch(html,/id="(?:sync|rescan|loadRows)"|사진 목록 맞추기|목록 새로고침|전체 다시 확인/);
});

test('refresh resumes an active scan and does not silently stop after 100 batches',async()=>{
  let steps=0;
  const h=harness(name=>({ok:true,data:name==='getStatus'?identity:name==='getAdminOverview'?overview({scan:{active:steps<105}}):name==='syncAdminCatalog'?{scan:{active:++steps<105,processed:steps,issues:0},pending:0}:{rows:[row]}}));
  h.run("session='admin-session'");await h.get('refresh').onclick();
  const scans=h.calls.filter(c=>c.name==='syncAdminCatalog');assert.equal(scans.length,105);
  assert.ok(scans.every(c=>c.args[1]===false));assert.equal(h.run('rows.length'),1);
  assert.match(h.get('message').textContent,/수량과 목록을 새로/);
});

test('pause keeps progress resumable and loads available rows without reporting completion',async()=>{
  const h=harness(name=>{if(name==='syncAdminCatalog')h.get('stopSync').onclick();return {ok:true,data:name==='getStatus'?identity:name==='getAdminOverview'?overview({scan:{active:true},scanComplete:false}):name==='syncAdminCatalog'?{scan:{active:true,processed:4,issues:0},pending:0}:{rows:[row]}};});
  h.run("session='admin-session'");await h.get('refresh').onclick();
  assert.equal(h.calls.filter(c=>c.name==='syncAdminCatalog').length,1);assert.equal(h.run('rows.length'),1);
  assert.match(h.get('message').textContent,/일시정지/);assert.doesNotMatch(h.get('message').textContent,/새로 불러왔습니다/);
  assert.equal(h.get('refresh').disabled,false);
});

test('failed scan or list load preserves the last list and never claims a successful refresh',async()=>{
  for(const failure of ['syncAdminCatalog','getAdminChunk']){
    const h=harness(name=>name===failure?{ok:false,code:'MYBOX',message:'test connection failed'}:{ok:true,data:name==='getStatus'?identity:name==='getAdminOverview'?overview():name==='syncAdminCatalog'?{scan:{active:false,processed:1,issues:0},pending:0}:{rows:[row]}});
    h.run("session='admin-session';rows=[{address:'last known address',province:'서울',photos:[]}]");await h.get('refresh').onclick();
    assert.equal(h.run('rows[0].address'),'last known address');assert.match(h.get('message').textContent,/test connection failed/);
    assert.equal(h.get('refresh').disabled,false);assert.equal(h.get('stopSync').hidden,true);
  }
});

test('scan issues stop the loop and warn instead of repeating a failed full scan forever',async()=>{
  const h=harness(name=>({ok:true,data:name==='getStatus'?identity:name==='getAdminOverview'?overview({scanComplete:false}):name==='syncAdminCatalog'?{scan:{active:false,processed:1,issues:1},pending:1}:{rows:[row]}}));
  h.run("session='admin-session'");await h.get('refresh').onclick();
  assert.equal(h.calls.filter(c=>c.name==='syncAdminCatalog').length,1);assert.match(h.get('message').textContent,/전체가 아닐 수/);
});

test('repeated clicks do not start concurrent scans and logout discards a late private reply',async()=>{
  let finish;
  const h=harness(()=>new Promise(resolve=>{finish=resolve;}));h.run("session='admin-session'");
  const first=h.get('refresh').onclick();await Promise.resolve();await h.get('refresh').onclick();
  assert.equal(h.calls.length,1);h.run('logout()');finish({ok:true,data:identity});await first;
  assert.equal(h.calls.length,1);assert.equal(h.run('rows.length'),0);assert.equal(h.get('workspace').hidden,true);
});

test('admin RPC timeout releases the UI and ignores late replies without replaying a write',async()=>{
  let expire,finish;
  const h=harness(()=>new Promise(resolve=>{finish=resolve;}),{setTimeout:fn=>{expire=fn;return 1;},clearTimeout(){}});
  const pending=h.run("once('syncAdminCatalog','admin-session',true)");await Promise.resolve();expire();
  await assert.rejects(pending,error=>error.code==='TIMEOUT');finish({ok:true,data:{late:true}});await Promise.resolve();
  assert.equal(h.calls.length,1);
});

test('administrator shows timestamps without GPS fields, while the original evidence object is preserved',()=>{
  const h=harness();h.run("selectedPhoto={evidence:{latitude:37.5665,longitude:126.978,accuracy:24,capturedAt:'2026-10-16T04:00:00Z',receivedAt:'2026-10-16T04:00:01Z'}}");
  const text=h.run('captureMeta(selectedPhoto)');assert.match(text,/촬영 기록/);assert.match(text,/서버 수신/);assert.doesNotMatch(text,/37\.5665|126\.978|GPS|거리|정확도/);
  assert.equal(h.run('selectedPhoto.evidence.latitude'),37.5665);assert.match(h.run('captureMeta({})'),/촬영 기록 없음/);
  assert.doesNotMatch(html,/positionMap|visit-distance\.js|GPS 추정|현재 위도|직선거리/);
});
