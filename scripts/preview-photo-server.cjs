// LOCAL TEST ONLY. Real gateway code with fake Apps Script/MYBOX services and no real credentials.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {harness,PASSWORD}=require('../tests/helpers/photo-harness.cjs');
const root=path.resolve(__dirname,'..'),sourceText=fs.readFileSync(path.join(root,'web/addresses.js'),'utf8');
const h=harness({sourceText,requireCapture:true}),app=h.app;
app.PHOTO_LIMITS_={...app.PHOTO_LIMITS_,webAppUrl:'http://127.0.0.1:8765/photos'};
const exposed=new Set(['getStatus','loginPhoto','uploadPhoto','getPhoto','listEmployees','manageEmployee','getAdminOverview','getAdminChunk','repairAdminCatalog','syncAdminCatalog','getPublicStatus','uploadPublicPhoto','getPublicPhoto','deletePhoto','getPublicUploadReceipt','beginPublicCapture']);
const mock=`<script>
let MOCK_OK,MOCK_FAIL;const runner=new Proxy({},{get(target,name){
 if(name==='withSuccessHandler')return fn=>{MOCK_OK=fn;return runner};
 if(name==='withFailureHandler')return fn=>{MOCK_FAIL=fn;return runner};
 return(...args)=>{const ok=MOCK_OK,fail=MOCK_FAIL;fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json()).then(ok,fail)};
}});window.google={script:{run:runner,url:{getLocation:fn=>fn({hash:location.hash.slice(1)})},history:{replace:(state,params,hash)=>{history.replaceState(state,'',location.pathname+'?'+new URLSearchParams(params)+(hash?'#'+hash:''))}}}};
</script>`;
function page(admin,address){const initial=JSON.stringify({address:address||'',maxBytes:200000,maxEdge:1600,webAppUrl:'http://127.0.0.1:8765/photos',version:'LOCAL-MOCK-V3'});
 return fs.readFileSync(path.join(root,'photo-backend',admin?'Admin.html':'Photo.html'),'utf8').replace('<?!= initialJson ?>',initial)
 .replace('<main>','<main><p style="color:#a43b27;font-weight:700">로컬 모의 테스트 — 실제 MYBOX 저장 아님</p>')
 .replace('<script id="initial"',mock+'<script id="initial"')
 .replaceAll('https://rep123-seven.vercel.app/addresses.js?v=20261016-photo','/addresses.js').replaceAll('https://rep123-seven.vercel.app/lib/','/lib/');
}
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const localCaptureMock=`<script>
document.querySelector('h1').textContent='모의 촬영 — 실제 방문 아님';
Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:ok=>ok({coords:{latitude:37.599408,longitude:127.06618,accuracy:12},timestamp:Date.now()})}});
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const c=document.createElement('canvas');c.width=1280;c.height=960;const g=c.getContext('2d');function frame(){g.fillStyle='#294a45';g.fillRect(0,0,1280,960);g.fillStyle='white';g.font='48px sans-serif';g.fillText('TEST ONLY / NOT A FIELD VISIT',80,400);requestAnimationFrame(frame);}frame();return c.captureStream(10);}}});
</script>`;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:8765');
 if(url.pathname==='/photos'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(page(url.searchParams.get('page')==='admin',url.searchParams.get('address')));}
 if(url.pathname==='/photo-config.js'){res.setHeader('Content-Type','application/javascript');return res.end('window.PHOTO_CONFIG='+JSON.stringify({webAppUrl:'http://127.0.0.1:8765/bridge',build:'LOCAL-MOCK-GPS',maxPhotos:2,maxBytes:200000})+';');}
 if(url.pathname==='/bridge'){res.setHeader('Content-Type','text/html; charset=utf-8');const channel=JSON.stringify(url.searchParams.get('channel'));
  return res.end(`<script>const channel=${channel};window.addEventListener('message',async event=>{if(event.origin!==location.origin||event.source!==parent||event.data.channel!==channel)return;const {id,name,args}=event.data;const result=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json());parent.postMessage({channel,id,type:'reply',result},location.origin);});parent.postMessage({channel,type:'ready',legacyKey:''},location.origin);</script>`);}
 if(url.pathname==='/api'&&req.method==='POST'){
  if(!['http://127.0.0.1:8765','http://localhost:8765'].includes(req.headers.origin)){res.writeHead(403);return res.end();}
  let body='';for await(const part of req){body+=part;if(body.length>1000000){res.writeHead(413);return res.end();}}
  try{const {name,args}=JSON.parse(body);if(!exposed.has(name)||!Array.isArray(args))throw Error('unknown RPC');const result=app[name](...args);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(result));}
  catch(error){res.writeHead(500);return res.end(JSON.stringify({ok:false,message:'모의 서버 요청 오류'}));}
 }
 const filename=path.resolve(root,'web','.'+(url.pathname==='/'?'/index.html':url.pathname==='/photo'?'/photo.html':decodeURIComponent(url.pathname)));
 if(!filename.startsWith(path.join(root,'web')+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(filename,(error,bytes)=>{if(error){res.writeHead(404);return res.end();}res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');
  if(path.basename(filename)==='photo.html')bytes=bytes.toString().replace('<script src="/photo-config.js',localCaptureMock+'<script src="/photo-config.js');
  if(path.basename(filename)==='field-photo.js')bytes=bytes.toString().replace("return value==='https://script.google.com'","return value===location.origin||value==='https://script.google.com'");
  res.end(bytes);});
});
server.listen(8765,'127.0.0.1',()=>console.log('LOCAL MOCK ONLY: /photos, /photos?page=admin. Admin password: '+PASSWORD));
