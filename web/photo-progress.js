(function(global){
  'use strict';
  function create(config,onSnapshot,onAddress){
    var lastMeta=null,running=null;
    async function call(action,fields){
      var response=await fetch('/api/photo-direct',{method:'POST',cache:'no-store',referrerPolicy:'no-referrer',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action},fields||{}))});
      var value=await response.json();if(!response.ok||!value.ok)throw Error(value.message||'사진 현황을 확인하지 못했습니다.');
      return value.data;
    }
    async function refresh(){
      if(running)return running;
      running=(async function(){
        var meta=await call('completionMeta'),version=String(meta.updatedAt||'')+'|'+JSON.stringify(meta.pendingAddresses||[]);
        if(version===lastMeta)return meta;
        var completed=new Set();for(var key of meta.keys||[]){
          var part=await call('completionChunk',{key:key});
          if(part.updatedAt!==meta.updatedAt)throw Error('사진 목록이 갱신돼 다시 확인해야 합니다.');
          (part.addresses||[]).forEach(function(address){completed.add(address);});
        }
        (meta.pendingAddresses||[]).forEach(function(address){completed.delete(address);});
        onSnapshot(completed,meta);lastMeta=version;return meta;
      })();
      try{return await running;}finally{running=null;}
    }
    async function check(address){var value=await call('status',{address:address,deviceKey:''});
      var count=Number(value.totalCount);if(!Number.isInteger(count)||count<0||count>2)throw Error('사진 수가 올바르지 않습니다.');
      onAddress(address,count);return count;}
    return {refresh:refresh,check:check};
  }
  global.PhotoMapProgress={create:create};
})(window);
