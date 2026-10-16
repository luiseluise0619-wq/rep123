const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../photo-backend/Admin.html'),'utf8');
const script=html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)[1].replace('refresh().catch(handle);','');
function harness(reply=()=>({ok:true,data:{}})){
  const elements=new Map(),calls=[],local=new Map(),tab=new Map();
  function element(){return {textContent:'',value:'',checked:false,disabled:false,hidden:false,children:[],style:{},classList:{toggle(){}},
    append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;},addEventListener(){},removeAttribute(){},close(){this.open=false;},showModal(){this.open=true;}};}
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  get('initial').textContent='{}';
  const storage=map=>({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
  let success,failure;
  const runner=new Proxy({},{get(target,name){if(name==='withSuccessHandler')return fn=>{success=fn;return runner;};if(name==='withFailureHandler')return fn=>{failure=fn;return runner;};return (...args)=>{calls.push({name,args});const ok=success,fail=failure;Promise.resolve().then(()=>reply(name,args)).then(ok,fail);};}});
  const window={google:{script:{run:runner}},localStorage:storage(local),sessionStorage:storage(tab),addEventListener(){},confirm:()=>true};
  const context=vm.createContext({window,google:window.google,document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},Date,JSON,Math,Number,String,Array,Promise,Error,setTimeout:fn=>fn()});
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
