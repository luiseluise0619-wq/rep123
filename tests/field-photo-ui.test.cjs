const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/field-photo.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../web/photo.html'),'utf8');

function harness(fetcher){
  const elements=new Map(),stored=new Map(),calls=[];
  const context={measureText:value=>({width:String(value).length*8}),drawImage(){},fillRect(){},fillText(){}};
  const element=()=>({textContent:'',hidden:false,disabled:false,checked:false,value:'',style:{},children:[],attributes:{},
    classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v;},showModal(){this.open=true;},close(){this.open=false;},
    append(...x){this.children.push(...x);},prepend(x){this.children.unshift(x);},replaceChildren(...x){this.children=x;},remove(){},
    removeAttribute(){},scrollIntoView(){},getTracks(){return [];},play:async()=>{},getContext:()=>context,
    toBlob:fn=>fn(new Blob(['test-jpeg'],{type:'image/jpeg'}))});
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const window={addEventListener(){}};
  const sandbox={window,document:{getElementById:get,querySelectorAll:()=>[],createElement:element,addEventListener(){}},
    location:{search:'?address=test'},navigator:{},crypto:crypto.webcrypto,URL,URLSearchParams,Uint8Array,Date,Intl,JSON,Number,
    Math,Array,Error,Promise,Set,Map,AbortSignal,Blob,FormData,setTimeout,clearTimeout,
    localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},
    fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body.action);return fetcher(url,options,body);}};
  vm.createContext(sandbox);
  vm.runInContext(source.replace('init().catch(entryError);',
    'window.test={init,entryError,once,controls,keepKey,renderPending,capture,openCamera,upload,stopCamera,photoState:()=>({deviceKey,busy,stream,pending})};'),sandbox);
  return {sandbox,get,calls,api:window.test};
}

test('photo screen contains only camera capture and no location or legacy script connection',()=>{
  assert.doesNotMatch(html,/type=["']file|앨범|id="bridge"|iframe/);
  assert.match(source,/getUserMedia/);
  assert.doesNotMatch(source,/geolocation|getCurrentPosition|script\.google|googleusercontent|postMessage|iframe/);
  for(const id of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(html.includes('id="'+id[1]+'"'),id[1]);
  const routes=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/vercel.json'),'utf8'));
  const policy=routes.headers.find(r=>r.source==='/photo').headers.find(h=>h.key==='Permissions-Policy').value;
  assert.match(policy,/geolocation=\(\)/);
});

test('photo screen checks the selected address and requests camera permit through Vercel only',async()=>{
  const h=harness((url,options,body)=>{
    assert.equal(url,'/api/photo-direct');
    const data=body.action==='status'?{ready:true,totalCount:0,photos:[],quota:{canUpload:true}}:{ticket:'test-ticket'};
    return Response.json({ok:true,data});
  });
  await h.api.init();assert.equal(h.get('admin').href,'/photo-admin');
  assert.equal(h.api.photoState().deviceKey.length,64);
  const permit=await h.api.once('beginPublicCapture',h.api.photoState().deviceKey,'test');
  assert.equal(permit.ticket,'test-ticket');assert.deepEqual(h.calls,['status','capture']);
});

test('unrecognized address stops capture and offers a retry',async()=>{
  const h=harness(()=>Response.json({ok:false,code:'ADDRESS',message:'원자료에 없는 주소'},{status:400}));
  await h.api.init().catch(h.api.entryError);
  assert.equal(h.get('entryLoading').hidden,true);assert.equal(h.get('retryConnection').hidden,false);
  assert.equal(h.get('startCamera').disabled,true);assert.match(h.get('message').textContent,/원자료에 없는 주소/);
});

test('two-photo actions and public consent remain in the simplified screen',()=>{
  assert.match(html,/>확인하고 한 장 더 찍기<\/button>/);
  assert.match(html,/누구나 볼 수 있도록 등록/);
  assert.match(html,/삭제는 올린 브라우저 또는 관리자만/);
  assert.match(source,/directUpload\(photo\)/);
  assert.doesNotMatch(source,/uploadPublicPhoto|FileReader/);
});
