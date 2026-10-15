// LOCAL UI TEST ONLY. No Google/MYBOX calls and no real credentials.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const address = '서울특별시 영등포구 당산동 1가 1';
const initial = JSON.stringify({address,maxBytes:200000,maxEdge:1600,version:'LOCAL-MOCK'});
const mock = `<script>
const MOCK_FILES=[];let MOCK_OK,MOCK_ERROR;
const runner=new Proxy({}, {get(target,name){
 if(name==='withSuccessHandler')return fn=>{MOCK_OK=fn;return runner};
 if(name==='withFailureHandler')return fn=>{MOCK_ERROR=fn;return runner};
 return (...args)=>{const ok=MOCK_OK,fail=MOCK_ERROR;setTimeout(async()=>{try{
 let data;
 if(name==='loginPhoto'){if(args[1]!=='preview-test-password')throw Error('테스트 암호가 다릅니다.');data={session:'LOCAL-TEST',name:args[0]};}
 if(name==='getStatus')data={ready:true,authenticated:args[0]==='LOCAL-TEST',name:'로컬 테스트',photos:MOCK_FILES.map(p=>p.photo),quota:{usedBytes:MOCK_FILES.reduce((n,p)=>n+p.photo.bytes,0),remainingSafeBytes:24000000000,canUpload:true}};
 if(name==='uploadPhoto'){if(args[0]!=='LOCAL-TEST')throw Error('로그인이 필요합니다.');if(MOCK_FILES.length>=2)throw Error('이미 2장입니다.');const photo={slot:MOCK_FILES.length+1,bytes:atob(args[2].base64).length,visitDate:args[2].visitDate,uploader:'로컬 테스트',uploadedAt:new Date().toISOString()};MOCK_FILES.push({photo,base64:args[2].base64});data={saved:true,alreadySaved:false,count:MOCK_FILES.length,photo};}
 if(name==='getPhoto')data=MOCK_FILES.find(p=>p.photo.slot===args[2]);
 ok({ok:true,data});}catch(error){fail(error);}},10)};
}});window.google={script:{run:runner}};
</script>`;
const html = fs.readFileSync(path.join(root,'photo-backend/Photo.html'),'utf8')
  .replace('<?!= initialJson ?>',initial)
  .replace('<main>','<main><p style="color:#a43b27;font-weight:700">로컬 모의 테스트 — 실제 MYBOX 저장 아님</p>')
  .replace('<script id="initial"',mock+'<script id="initial"');
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 if(req.url.split('?')[0]==='/photos'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
 const filename=path.resolve(root,'web','.'+decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
 if(!filename.startsWith(path.join(root,'web')+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(filename,(error,bytes)=>{if(error){res.writeHead(404);return res.end();}res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.end(bytes);});
});
server.listen(8765,'127.0.0.1',()=>console.log('Local-only photo UI: http://127.0.0.1:8765/photos'));
