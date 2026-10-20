(function(global){
  'use strict';
  function random(bytes){return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
  function bridgeOrigin(value){return value==='https://script.google.com'||/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(value);}
  function create(config,onSnapshot,onAddress){
    var base=String(config&&config.webAppUrl||'');
    if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(base))return null;
    var channel=random(32),requests=new Map(),remote=null,remoteOrigin='',connectedResolve,connectedReject,lastMeta=null,running=null;
    var connected=new Promise(function(resolve,reject){connectedResolve=resolve;connectedReject=reject;});
    var timer=setTimeout(function(){connectedReject(Error('사진 현황 연결 시간 초과'));},30000);
    function receive(event){
      var data=event.data;
      if(!data||data.channel!==channel||!bridgeOrigin(event.origin))return;
      if(data.type==='ready'&&!remote){remote=event.source;remoteOrigin=event.origin;clearTimeout(timer);connectedResolve();return;}
      if(event.source!==remote||event.origin!==remoteOrigin||data.type!=='reply')return;
      var item=requests.get(data.id);if(!item)return;
      requests.delete(data.id);clearTimeout(item.timer);
      if(data.result&&data.result.ok)item.resolve(data.result.data);
      else {var error=Error(data.result&&data.result.message||'사진 현황을 확인하지 못했습니다.');error.code=data.result&&data.result.code;item.reject(error);}
    }
    global.addEventListener('message',receive);
    var frame=document.createElement('iframe');frame.hidden=true;frame.title='사진 등록 현황';frame.referrerPolicy='no-referrer';
    frame.src=base+'?page=bridge&channel='+channel+'&build='+encodeURIComponent(config.build||'');
    document.body.appendChild(frame);
    async function once(name,args){await connected;return new Promise(function(resolve,reject){
      var id=random(12),requestTimer=setTimeout(function(){requests.delete(id);reject(Error('사진 현황 응답 시간 초과'));},45000);
      requests.set(id,{resolve:resolve,reject:reject,timer:requestTimer});
      remote.postMessage({channel:channel,id:id,name:name,args:args},remoteOrigin);
    });}
    async function call(name,args){for(var attempt=0;;attempt++){try{return await once(name,args);}catch(error){
      if(error.code!=='BUSY'||attempt>=3)throw error;
      await new Promise(function(resolve){setTimeout(resolve,1500*(attempt+1));});
    }}}
    async function refresh(){
      if(running)return running;
      running=(async function(){
        var meta=await call('getPublicCompletionMeta',[]),version=String(meta.updatedAt||'')+'|'+JSON.stringify(meta.pendingAddresses||[]);
        if(version===lastMeta)return meta;
        var completed=new Set(),keys=Array.isArray(meta.keys)?meta.keys:[];
        for(var i=0;i<keys.length;i++){
          var chunk=await call('getPublicCompletionChunk',[keys[i]]);
          if(chunk.updatedAt!==meta.updatedAt)throw Error('사진 목록이 갱신돼 다시 확인해야 합니다.');
          (chunk.addresses||[]).forEach(function(address){completed.add(address);});
        }
        (meta.pendingAddresses||[]).forEach(function(address){completed.delete(address);});
        onSnapshot(completed,meta);lastMeta=version;return meta;
      })();
      try{return await running;}finally{running=null;}
    }
    async function check(address){
      var result=await call('getPublicStatus',[address,'']);
      var count=Number(result.totalCount);
      if(!Number.isInteger(count)||count<0||count>2)throw Error('사진 수가 올바르지 않습니다.');
      onAddress(address,count);return count;
    }
    return {refresh:refresh,check:check};
  }
  global.PhotoMapProgress={create:create};
})(window);
