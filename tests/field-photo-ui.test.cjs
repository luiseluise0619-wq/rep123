const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/field-photo.js'),'utf8');
const html=fs.readFileSync(require('node:path').join(__dirname,'../web/photo.html'),'utf8');
function harness(){const elements=new Map(),events={},stored=new Map(),timers=new Map();let seq=0,frames=0;
 const context={measureText:value=>({width:String(value).length*8}),drawImage(){},fillRect(){},fillText(){}};
 const element=()=>({textContent:'',hidden:false,disabled:false,checked:false,value:'',style:{},children:[],classList:{toggle(){}},append(...x){this.children.push(...x);},prepend(x){this.children.unshift(x);},replaceChildren(...x){this.children=x;},remove(){},removeAttribute(){},scrollIntoView(){this.scrolled=true;},getTracks(){return [];},play:async()=>{},getContext:()=>context,toBlob:fn=>fn(new Blob(['test-jpeg-'+(++frames)],{type:'image/jpeg'}))});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const window={PHOTO_DISTANCE_:require('../web/lib/visit-distance.js'),PHOTO_CONFIG:{webAppUrl:'https://script.google.com/macros/s/test/exec'},addEventListener:(name,fn)=>events[name]=fn};
 const sandbox={window,document:{getElementById:get,querySelectorAll:()=>[],createElement:element,addEventListener(){}},location:{search:'?address=test'},navigator:{},
 crypto:crypto.webcrypto,URL,URLSearchParams,Uint8Array,Date,Intl,JSON,Number,Math,Array,Error,Promise,Set,Map,
 FileReader:class {readAsDataURL(blob){blob.arrayBuffer().then(value=>{this.result='data:image/jpeg;base64,'+Buffer.from(value).toString('base64');this.onload();});}},
 localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(sandbox);vm.runInContext(source.replace('init().catch(error=>say(error.message,true));','window.test={once,controls,bridgeOrigin,connected,channel,requests,keepKey,locationText,distanceText,renderPending,capture,openCamera,upload,stopCamera,setDestination:value=>{destination=value;},setPending:value=>{pending=value;},setReady:()=>{canUpload=true;deviceKey="a".repeat(64);},photoState:()=>({deviceKey,busy,stream,pending})};'),sandbox);
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

test('camera and pending cards show destination distance separately from a 24m GPS accuracy',()=>{
 const h=harness(),gps={latitude:37.5665,longitude:126.978,accuracy:24};
 h.api.setDestination({latitude:34.8118,longitude:126.3922,coordinateVerified:true});
 const text=h.api.locationText(gps);assert.match(text,/방문지까지 직선거리 3\d\d\.\d{2}km/);assert.match(text,/GPS 정확도\(휴대폰 추정\) 약 ±24m/);
 assert.doesNotMatch(text,/직선거리 24m/);
 h.api.setPending([{blob:{size:20000},url:'mock-image',gps}]);h.api.renderPending();
 const caption=h.get('pending').children[0].children[1].textContent;assert.match(caption,/직선거리 3\d\d\.\d{2}km/);assert.match(caption,/±24m/);
 h.api.setDestination({...gps,coordinateVerified:false});assert.match(h.api.locationText(gps),/직선거리 0m.*대략 좌표/);
 h.api.setDestination(null);assert.match(h.api.distanceText(gps),/확인 불가/);
});

function captureHarness(){
 const h=harness(),calls=[];let saved=0,stops=0;
 const remote={postMessage:message=>{calls.push(message.name);const data=message.name==='getPublicUploadReceipt'?{saved:false}:message.name==='uploadPublicPhoto'?(saved++,{}):message.name==='getPublicStatus'?{ready:true,totalCount:saved,photos:[],quota:{canUpload:true}}:{ticket:'test-only-ticket'};queueMicrotask(()=>h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'reply',id:message.id,result:{ok:true,data}}}));}};
 h.events.message({origin:'https://safe-script.googleusercontent.com',source:remote,data:{channel:h.api.channel,type:'ready'}});
 h.api.setReady();h.get('locationConsent').checked=true;h.get('cameraVideo').videoWidth=100;h.get('cameraVideo').videoHeight=100;
 h.sandbox.navigator.geolocation={getCurrentPosition:fn=>fn({coords:{latitude:37.599408,longitude:127.06618,accuracy:24},timestamp:Date.now()})};
 h.sandbox.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop(){stops++;}}]})};
 return {...h,calls,stops:()=>stops};
}

test('each photo stops the camera, requires review, then allows one more capture and a single send action',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();
 assert.equal(h.stops(),1);assert.equal(h.api.photoState().stream,null);assert.equal(h.get('cameraPanel').hidden,true);
 assert.equal(h.api.photoState().pending.length,1);assert.equal(h.api.photoState().pending[0].confirmed,false);
 assert.equal(h.get('reviewPanel').hidden,false);assert.equal(h.get('startCamera').hidden,true);assert.equal(h.get('saveControls').hidden,true);
 assert.deepEqual(h.calls,['beginPublicCapture']);
 h.get('pending').children[0].children[2].onclick();assert.equal(h.api.photoState().pending[0].confirmed,true);
 assert.equal(h.get('startCamera').textContent,'한 장 더 찍기');assert.equal(h.get('startCamera').hidden,false);
 assert.deepEqual(h.calls,['beginPublicCapture'],'confirmation alone never uploads');
 await h.api.openCamera();assert.equal(h.get('reviewPanel').hidden,true);assert.equal(h.get('saveControls').hidden,true);
 await h.api.capture();assert.equal(h.stops(),2);assert.equal(h.api.photoState().pending.length,2);
 assert.equal(h.api.photoState().pending[0].confirmed,true);assert.equal(h.api.photoState().pending[1].confirmed,false);
 h.get('pending').children[1].children[2].onclick();assert.equal(h.get('startCamera').hidden,true);
 assert.equal(h.get('upload').disabled,true);h.get('publicConsent').checked=true;h.api.controls();assert.equal(h.get('upload').disabled,false);
 assert.equal(h.get('upload').textContent,'2장 전송');await h.api.upload();
 assert.equal(h.api.photoState().pending.length,0);assert.equal(h.get('count').textContent,'2 / 2');
 assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,2);assert.equal(h.api.photoState().stream,null);
});

test('an unconfirmed photo cannot be uploaded or skipped, and retake preserves an earlier confirmed photo',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();
 h.get('publicConsent').checked=true;await h.api.upload();assert.match(h.get('message').textContent,/사진마다.*확인/);
 const before=h.calls.length;await h.api.openCamera();assert.equal(h.calls.length,before);assert.match(h.get('message').textContent,/먼저 확인/);
 h.get('pending').children[0].children[2].onclick();const first=h.api.photoState().pending[0];
 await h.api.openCamera();await h.api.capture();await h.get('pending').children[1].children[3].onclick();
 assert.equal(h.api.photoState().pending.length,1);assert.equal(h.api.photoState().pending[0],first);
 assert.equal(first.confirmed,true);assert.ok(h.api.photoState().stream);h.api.stopCamera();
});

test('one confirmed photo can still be sent, and a failed compression does not leave the camera running',async()=>{
 const h=captureHarness();await h.api.openCamera();await h.api.capture();h.get('pending').children[0].children[2].onclick();
 h.get('publicConsent').checked=true;await h.api.upload();assert.equal(h.calls.filter(name=>name==='uploadPublicPhoto').length,1);
 const failed=captureHarness(),original=failed.sandbox.document.createElement;
 failed.sandbox.document.createElement=name=>{const el=original(name);if(name==='canvas')el.toBlob=fn=>fn(null);return el;};
 await failed.api.openCamera();await failed.api.capture();assert.equal(failed.stops(),1);assert.equal(failed.api.photoState().stream,null);
 assert.equal(failed.api.photoState().pending.length,0);assert.match(failed.get('message').textContent,/사진 변환에 실패/);
});
