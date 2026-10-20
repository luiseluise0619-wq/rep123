const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../web/photo-progress.js'),'utf8');

test('public map progress loads completed addresses, excludes pending rows and checks a clicked address',async()=>{
  let receive,frame,completed,count,requests=[];
  const remote={postMessage(message){requests.push(message.name);
    const data=message.name==='getPublicCompletionMeta'?{keys:['a'],updatedAt:'version-1',pendingAddresses:['pending'],pending:1}:
      message.name==='getPublicCompletionChunk'?{key:'a',addresses:['completed','pending'],updatedAt:'version-1'}:
      {ready:true,totalCount:2};
    queueMicrotask(()=>receive({origin:'https://script.google.com',source:remote,data:{type:'reply',channel:message.channel,id:message.id,result:{ok:true,data}}}));
  }};
  const window={addEventListener(name,fn){if(name==='message')receive=fn;}};
  const document={createElement(){return {};},body:{appendChild(value){frame=value;
    const channel=new URL(frame.src).searchParams.get('channel');
    queueMicrotask(()=>receive({origin:'https://script.google.com',source:remote,data:{type:'ready',channel}}));
  }}};
  const context={window,document,crypto:webcrypto,Map,Set,Promise,URL,Uint8Array,setTimeout,clearTimeout,queueMicrotask};
  vm.createContext(context);vm.runInContext(source,context);
  const service=window.PhotoMapProgress.create({webAppUrl:'https://script.google.com/macros/s/test/exec',build:'test'},
    value=>completed=Array.from(value),(_,value)=>count=value);
  await service.refresh();
  assert.deepEqual(completed,['completed']);
  assert.equal(await service.check('completed'),2);
  assert.equal(count,2);
  assert.deepEqual(requests,['getPublicCompletionMeta','getPublicCompletionChunk','getPublicStatus']);
  assert.match(frame.src,/page=bridge/);
});

test('direct map progress uses only the Vercel API and never creates an Apps Script bridge',async()=>{
  const calls=[];let complete,count;
  const context={window:{addEventListener(){throw Error('legacy bridge activated');}},
    document:{createElement(){throw Error('legacy iframe created');}},crypto:webcrypto,Map,Set,Promise,URL,Uint8Array,
    fetch:async(url,options)=>{assert.equal(url,'/api/photo-direct');const action=JSON.parse(options.body).action;calls.push(action);
      const data=action==='completionMeta'?{keys:['a'],updatedAt:'v2',pendingAddresses:['waiting']}:
        action==='completionChunk'?{addresses:['done','waiting'],updatedAt:'v2'}:{totalCount:2};
      return Response.json({ok:true,data});}};
  vm.createContext(context);vm.runInContext(source,context);
  const service=context.window.PhotoMapProgress.create({directEnabled:true,webAppUrl:'https://script.google.com/macros/s/test/exec'},
    value=>complete=Array.from(value),(_,value)=>count=value);
  await service.refresh();assert.deepEqual(complete,['done']);
  assert.equal(await service.check('done'),2);assert.equal(count,2);
  assert.deepEqual(calls,['completionMeta','completionChunk','status']);
});
