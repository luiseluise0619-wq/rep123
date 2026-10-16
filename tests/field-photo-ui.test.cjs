const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/field-photo.js'),'utf8');
const html=fs.readFileSync(require('node:path').join(__dirname,'../web/photo.html'),'utf8');
function harness(){const elements=new Map(),events={},stored=new Map(),timers=new Map();let seq=0;
 const element=()=>({textContent:'',hidden:false,disabled:false,checked:false,value:'',style:{},children:[],classList:{toggle(){}},append(...x){this.children.push(...x);},prepend(x){this.children.unshift(x);},replaceChildren(...x){this.children=x;},remove(){},removeAttribute(){},getTracks(){return [];}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const window={PHOTO_CONFIG:{webAppUrl:'https://script.google.com/macros/s/test/exec'},addEventListener:(name,fn)=>events[name]=fn};
 const sandbox={window,document:{getElementById:get,querySelectorAll:()=>[],createElement:element,addEventListener(){}},location:{search:'?address=test'},navigator:{},
 crypto:crypto.webcrypto,URL,URLSearchParams,Uint8Array,Date,Intl,JSON,Number,Math,Array,Error,Promise,Set,Map,
 localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(sandbox);vm.runInContext(source.replace('init().catch(error=>say(error.message,true));','window.test={once,controls,bridgeOrigin,connected,channel,requests,keepKey,photoState:()=>({deviceKey,busy})};'),sandbox);
 return {sandbox,get,events,timers,run:s=>vm.runInContext(s,sandbox),api:window.test};
}
test('only live camera capture exists; album/file selection and GPS in public stamp are absent',()=>{
 assert.ok(!/type=["']file|앨범/.test(html));assert.match(source,/getUserMedia/);assert.match(source,/getCurrentPosition/);
 const stamp=source.slice(source.indexOf('function stamp('),source.indexOf('async function compress('));assert.ok(!/latitude|longitude|accuracy/.test(stamp));
 for(const id of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(html.includes('id="'+id[1]+'"'),id[1]);
});
test('bridge validates origin, nonce and reply window, preserving legacy browser ownership without URL secrets',async()=>{
 const h=harness(),sent=[],remote={postMessage:(value,origin)=>sent.push({value,origin})};
 assert.equal(h.api.bridgeOrigin('https://evil-script.googleusercontent.com.evil.test'),false);
 h.events.message({origin:'https://evil.test',source:remote,data:{channel:h.api.channel,type:'ready',legacyKey:'a'.repeat(64)}});
 assert.equal(h.api.photoState().deviceKey,'');
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'ready',legacyKey:'a'.repeat(64)}});
 await h.api.connected;assert.equal(h.api.photoState().deviceKey,'a'.repeat(64));
 const call=h.api.once('getPublicStatus','test','a'.repeat(64));await new Promise(setImmediate);
 assert.equal(sent.length,1);assert.equal(sent[0].origin,'https://safe-script.googleusercontent.com');
 const data={channel:h.api.channel,type:'reply',id:sent[0].value.id,result:{ok:true,data:{done:true}}};
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:{},data});assert.equal(h.api.requests.size,1);
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data});assert.equal((await call).done,true);
 assert.equal(h.api.requests.size,0);
});
test('upload timeout is bounded, keeps uncertain status distinct, and ignores late replies',async()=>{
 const h=harness(),sent=[],remote={postMessage:value=>sent.push(value)};
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'ready'}});
 const call=h.api.once('uploadPublicPhoto','key','address',{});await new Promise(setImmediate);
 const timeout=[...h.timers.values()].find(t=>t.ms===90000);assert.ok(timeout);timeout.fn();
 await assert.rejects(call,error=>error.code==='TIMEOUT'&&error.message.includes('저장 여부를 확인하지 못했'));
 assert.equal(h.api.requests.size,0);
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'reply',id:sent[0].id,result:{ok:true,data:{saved:true}}}});
 assert.equal(h.api.requests.size,0);
});
