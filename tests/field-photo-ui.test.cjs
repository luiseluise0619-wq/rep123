const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/field-photo.js'),'utf8');
const html=fs.readFileSync(require('node:path').join(__dirname,'../web/photo.html'),'utf8');
function harness(){const elements=new Map(),events={},stored=new Map(),timers=new Map();let seq=0,frames=0;
 const context={measureText:value=>({width:String(value).length*8}),drawImage(){},fillRect(){},fillText(){}};
 const element=()=>({textContent:'',hidden:false,disabled:false,checked:false,value:'',style:{},children:[],attributes:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v;},showModal(){this.open=true;},close(){this.open=false;},append(...x){this.children.push(...x);},prepend(x){this.children.unshift(x);},replaceChildren(...x){this.children=x;},remove(){},removeAttribute(){},scrollIntoView(){this.scrolled=true;},getTracks(){return [];},play:async()=>{},getContext:()=>context,toBlob:fn=>fn(new Blob(['test-jpeg-'+(++frames)],{type:'image/jpeg'}))});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const window={PHOTO_CONFIG:{webAppUrl:'https://script.google.com/macros/s/test/exec'},addEventListener:(name,fn)=>events[name]=fn};
 const sandbox={window,document:{getElementById:get,querySelectorAll:()=>[],createElement:element,addEventListener(){}},location:{search:'?address=test'},navigator:{},
 crypto:crypto.webcrypto,URL,URLSearchParams,Uint8Array,Date,Intl,JSON,Number,Math,Array,Error,Promise,Set,Map,
 FileReader:class {readAsDataURL(blob){blob.arrayBuffer().then(value=>{this.result='data:image/jpeg;base64,'+Buffer.from(value).toString('base64');this.onload();});}},
 localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(sandbox);vm.runInContext(source.replace('init().catch(entryError);','window.test={init,entryError,once,controls,bridgeOrigin,connected,channel,requests,keepKey,renderPending,capture,openCamera,upload,stopCamera,setPending:value=>{pending=value;},setReady:()=>{addressReady=true;canUpload=true;deviceKey="a".repeat(64);},photoState:()=>({deviceKey,busy,stream,pending})};'),sandbox);
 return {sandbox,get,events,timers,run:s=>vm.runInContext(s,sandbox),api:window.test};
}
test('only live camera capture exists; album/file selection and GPS in public stamp are absent',()=>{
 assert.ok(!/type=["']file|앨범/.test(html));assert.match(source,/getUserMedia/);assert.doesNotMatch(source,/geolocation|getCurrentPosition|locationConsent|latitude|longitude|accuracy/);
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

test('camera flow has no GPS UI or permission gate and the photo route blocks geolocation',()=>{
 const h=harness();h.api.setReady();h.api.controls();assert.equal(h.get('startCamera').disabled,false);assert.equal(h.get('startCamera').textContent,'사진 찍기');
 assert.doesNotMatch(html,/id="(?:locationConsent|locationInfo|coordinateWarning)"|visit-distance\.js|직선거리|GPS 정확도/);
 const routes=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../web/vercel.json'),'utf8'));
 const policy=routes.headers.find(r=>r.source==='/photo').headers.find(h=>h.key==='Permissions-Policy').value;assert.match(policy,/geolocation=\(\)/);
});

function captureHarness({failUploadAt=0,uncertainSavedAt=0}={}){
 const h=harness(),calls=[];let saved=0,stops=0,attempts=0;
 const remote={postMessage:message=>{calls.push(message.name);let result;
  if(message.name==='uploadPublicPhoto'&&++attempts===failUploadAt)result={ok:false,code:'STORAGE_ERROR',message:'모의 저장 실패'};
  else if(message.name==='uploadPublicPhoto'&&attempts===uncertainSavedAt){saved++;result={ok:false,code:'CONNECTION',message:'응답 유실'};}
  else {const data=message.name==='getPublicUploadReceipt'?{saved:saved>0}:message.name==='uploadPublicPhoto'?(saved++,{}):message.name==='getPublicStatus'?{ready:true,totalCount:saved,photos:[],quota:{canUpload:true}}:{ticket:'test-only-ticket'};result={ok:true,data};}
  queueMicrotask(()=>h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'reply',id:message.id,result}}));}};
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'ready'}});
 h.api.setReady();h.get('cameraVideo').videoWidth=100;h.get('cameraVideo').videoHeight=100;
 h.sandbox.navigator.geolocation={getCurrentPosition:()=>{throw Error('GPS must never be requested');}};
 h.sandbox.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop(){stops++;}}]})};
 return {...h,calls,stops:()=>stops};
}

test('combined review actions open the next camera and send both photos without separate confirmation clicks',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();
 assert.equal(h.stops(),1);assert.equal(h.api.photoState().stream,null);assert.equal(h.get('cameraPanel').hidden,true);
 assert.equal(h.api.photoState().pending.length,1);assert.equal(h.api.photoState().pending[0].confirmed,false);
 assert.equal(h.get('reviewPanel').hidden,false);assert.equal(h.get('startCamera').hidden,true);assert.equal(h.get('saveControls').hidden,true);
 assert.equal(h.get('confirmNext').hidden,false);assert.equal(h.get('upload').textContent,'확인하고 1장만 전송');
 assert.match(html,/>확인하고 한 장 더 찍기<\/button>/);assert.equal(h.get('pending').children[0].children.length,3);
 assert.deepEqual(h.calls,['beginPublicCapture']);
 assert.ok(!Object.hasOwn(h.api.photoState().pending[0],'gps'));
 await h.get('confirmNext').onclick();assert.equal(h.api.photoState().pending[0].confirmed,true);assert.ok(h.api.photoState().stream);
 assert.deepEqual(h.calls,['beginPublicCapture'],'confirm-and-next never uploads');
 assert.equal(h.get('reviewPanel').hidden,true);assert.equal(h.get('saveControls').hidden,true);
 await h.api.capture();assert.equal(h.stops(),2);assert.equal(h.api.photoState().pending.length,2);
 assert.equal(h.api.photoState().pending[0].confirmed,true);assert.equal(h.api.photoState().pending[1].confirmed,false);
 assert.equal(h.get('saveControls').hidden,false);assert.equal(h.get('singlePhotoToggle').hidden,true);
 assert.equal(h.get('confirmNext').hidden,true);assert.equal(h.get('startCamera').hidden,true);
 assert.equal(h.get('upload').disabled,true);h.get('publicConsent').checked=true;h.api.controls();assert.equal(h.get('upload').disabled,false);
 assert.equal(h.get('upload').textContent,'확인하고 전송');await h.get('upload').onclick();
 assert.equal(h.api.photoState().pending.length,0);assert.equal(h.get('count').textContent,'2 / 2');
 assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,2);assert.equal(h.api.photoState().stream,null);
 assert.equal(h.calls.filter(name=>name==='getPublicUploadReceipt').length,0,'normal registration skips the redundant receipt round trip');
});

test('uncertain upload reply checks the receipt and does not submit the same photo twice',async()=>{
 const h=captureHarness({uncertainSavedAt:1});await h.api.openCamera();await h.api.capture();
 h.get('singlePhotoToggle').onclick();h.get('publicConsent').checked=true;await h.get('upload').onclick();
 assert.equal(h.api.photoState().pending.length,0);assert.equal(h.get('count').textContent,'1 / 2');
 assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,1);
 assert.equal(h.calls.filter(name=>name==='getPublicUploadReceipt').length,1);
});

test('an unconfirmed photo cannot be uploaded or skipped, and retake preserves an earlier confirmed photo',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();
 h.get('publicConsent').checked=true;await h.api.upload();assert.match(h.get('message').textContent,/사진마다.*확인/);
 const before=h.calls.length;await h.api.openCamera();assert.equal(h.calls.length,before);assert.match(h.get('message').textContent,/먼저 확인/);
 await h.get('confirmNext').onclick();const first=h.api.photoState().pending[0];
 await h.api.capture();await h.get('pending').children[1].children[2].onclick();
 assert.equal(h.api.photoState().pending.length,1);assert.equal(h.api.photoState().pending[0],first);
 assert.equal(first.confirmed,true);assert.ok(h.api.photoState().stream);h.api.stopCamera();
});

test('one photo can be confirmed and sent in a single action, and compression failure stops the camera',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();
 h.get('singlePhotoToggle').onclick();assert.equal(h.get('saveControls').hidden,false);
 h.get('publicConsent').checked=true;await h.get('upload').onclick();assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,1);
 assert.equal(h.get('startCamera').hidden,false,'single-photo mode must reset after a successful send');
 const failed=captureHarness(),original=failed.sandbox.document.createElement;
 failed.sandbox.document.createElement=name=>{const el=original(name);if(name==='canvas')el.toBlob=fn=>fn(null);return el;};
 await failed.api.openCamera();await failed.api.capture();assert.equal(failed.stops(),1);assert.equal(failed.api.photoState().stream,null);
 assert.equal(failed.api.photoState().pending.length,0);assert.match(failed.get('message').textContent,/사진 변환에 실패/);
});

test('combined send still requires explicit public consent and does not approve or send without it',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();await h.get('upload').onclick();
 assert.equal(h.api.photoState().pending[0].confirmed,false);assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,0);
 assert.match(h.get('message').textContent,/공개 등록 안내/);
});

test('denying the next camera preserves the first approved photo and allows retry or single-photo send',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();const first=h.api.photoState().pending[0];
 h.sandbox.navigator.mediaDevices.getUserMedia=async()=>{throw Error('camera denied');};await h.get('confirmNext').onclick();
 assert.equal(h.api.photoState().pending[0],first);assert.equal(first.confirmed,true);assert.equal(h.api.photoState().stream,null);
 assert.equal(h.get('startCamera').hidden,false);assert.equal(h.get('startCamera').disabled,false);h.get('singlePhotoToggle').onclick();assert.equal(h.get('saveControls').hidden,false);
 h.get('publicConsent').checked=true;await h.get('upload').onclick();assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,1);
});

test('double-clicking combined actions cannot open duplicate cameras or upload a photo twice',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();let openCount=0,release;
 h.sandbox.navigator.mediaDevices.getUserMedia=()=>{openCount++;return new Promise(resolve=>{release=()=>resolve({getTracks:()=>[{stop(){}}]});});};
 const next=h.get('confirmNext').onclick();await new Promise(setImmediate);await h.get('confirmNext').onclick();assert.equal(openCount,1);release();await next;
 await h.api.capture();h.get('publicConsent').checked=true;
 await Promise.all([h.get('upload').onclick(),h.get('upload').onclick()]);assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,2);
});

test('single-photo controls are folded by default, reversible without losing a capture, and never silently consent',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();const photo=h.api.photoState().pending[0];
 assert.equal(h.get('captureTitle').textContent,'사진 확인');assert.equal(h.get('remaining').textContent,'1 / 2장');
 assert.equal(h.get('singlePhotoToggle').hidden,false);assert.equal(h.get('saveControls').hidden,true);assert.equal(h.get('publicConsent').checked,false);
 h.get('singlePhotoToggle').onclick();assert.equal(h.get('singlePhotoToggle').attributes['aria-expanded'],'true');
 assert.equal(h.get('confirmNext').hidden,true);assert.equal(h.get('saveControls').hidden,false);assert.equal(h.get('upload').disabled,true);
 h.get('singlePhotoToggle').onclick();assert.equal(h.get('singlePhotoToggle').attributes['aria-expanded'],'false');
 assert.equal(h.get('confirmNext').hidden,false);assert.equal(h.get('saveControls').hidden,true);assert.equal(h.api.photoState().pending[0],photo);
 assert.deepEqual(h.calls,['beginPublicCapture']);
});

test('partially failed combined send retains the unsaved photo and offers retry without re-uploading the first',async()=>{
 const h=captureHarness({failUploadAt:2});await h.api.openCamera();await h.api.capture();await h.get('confirmNext').onclick();await h.api.capture();
 h.get('publicConsent').checked=true;await h.get('upload').onclick();assert.match(h.get('message').textContent,/모의 저장 실패/);
 assert.equal(h.api.photoState().pending.length,1);assert.equal(h.api.photoState().pending[0].confirmed,true);
 assert.equal(h.get('saveControls').hidden,false);assert.equal(h.get('upload').disabled,false);assert.equal(h.get('upload').textContent,'확인하고 전송');
 await h.get('upload').onclick();assert.equal(h.api.photoState().pending.length,0);assert.equal(h.get('count').textContent,'2 / 2');
 assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,3,'first success, second failure, second retry only');
});

test('photo preview is keyboard-accessible and the condensed page preserves consent, status and deletion notices',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();const image=h.get('pending').children[0].children[0];
 assert.equal(image.tabIndex,0);let prevented=false;image.onkeydown({key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(h.get('zoom').open,true);
 assert.match(html,/color-scheme:light/);assert.match(html,/--accent:#2563eb/);assert.doesNotMatch(html,/#efebe3|#fbf9f3|--teal|class="pill"/);
 assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/누구나 볼 수 있도록 등록/);assert.match(html,/삭제는 올린 브라우저 또는 관리자만/);
});

test('photo entry shows a static loader and needs no map dataset before authoritative server validation',async()=>{
 assert.doesNotMatch(html,/<script[^>]*addresses\.js/);assert.doesNotMatch(source,/ADDR_DATA/);assert.match(html,/사진 화면을 여는 중…/);
 const h=harness();h.get('captureCard').hidden=true;const sent=[],remote={postMessage:message=>{sent.push(message.name);queueMicrotask(()=>h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'reply',id:message.id,result:{ok:true,data:{ready:true,totalCount:0,photos:[],quota:{canUpload:true}}}}}));}};
 const pending=h.api.init();assert.equal(h.get('entryLoading').hidden,false);assert.equal(h.get('captureCard').hidden,true);
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'ready'}});await pending;
 assert.deepEqual(sent,['getPublicStatus']);assert.equal(h.get('entryLoading').hidden,true);assert.equal(h.get('captureCard').hidden,false);assert.equal(h.get('startCamera').disabled,false);
});

test('a rejected source address never enables capture and shows retry instead of a permanent loading message',async()=>{
 const h=harness();h.get('captureCard').hidden=true;const remote={postMessage:message=>queueMicrotask(()=>h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'reply',id:message.id,result:{ok:false,code:'ADDRESS',message:'원자료에 없는 주소'}}}))};
 const pending=h.api.init().catch(h.api.entryError);h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'ready'}});await pending;h.api.controls();
 assert.equal(h.get('entryLoading').hidden,true);assert.equal(h.get('retryConnection').hidden,false);assert.equal(h.get('captureCard').hidden,true);assert.equal(h.get('startCamera').disabled,true);assert.match(h.get('message').textContent,/원자료에 없는 주소/);
});
