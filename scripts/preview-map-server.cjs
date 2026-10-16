// Local static preview only. Serves the public web directory, never repository secrets.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../web');
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
http.createServer((req,res)=>{
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1:8766').pathname);}catch{res.writeHead(400);return res.end();}
 if(pathname==='/')pathname='/index.html';else if(!path.extname(pathname))pathname+='.html';
 const filename=path.resolve(root,'.'+pathname);
 if(!filename.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(filename,(error,bytes)=>{if(error){res.writeHead(404);return res.end();}res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(bytes);});
}).listen(8766,'127.0.0.1',()=>console.log('Local map preview: http://127.0.0.1:8766'));
