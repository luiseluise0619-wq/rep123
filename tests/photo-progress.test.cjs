const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/photo-progress.js'),'utf8');

test('public map progress loads completed addresses from Vercel and excludes pending rows',async()=>{
  const calls=[];let complete,count;
  const context={window:{},Map,Set,Promise,
    fetch:async(url,options)=>{assert.equal(url,'/api/photo-direct');const action=JSON.parse(options.body).action;calls.push(action);
      const data=action==='completionMeta'?{keys:['a'],updatedAt:'v2',pendingAddresses:['waiting']}:
        action==='completionChunk'?{addresses:['done','waiting'],updatedAt:'v2'}:{totalCount:2};
      return Response.json({ok:true,data});}};
  vm.createContext(context);vm.runInContext(source,context);
  const service=context.window.PhotoMapProgress.create({},
    value=>complete=Array.from(value),(_,value)=>count=value);
  await service.refresh();assert.deepEqual(complete,['done']);
  assert.equal(await service.check('done'),2);assert.equal(count,2);
  assert.deepEqual(calls,['completionMeta','completionChunk','status']);
  assert.doesNotMatch(source,/iframe|postMessage|script\.google/);
});
