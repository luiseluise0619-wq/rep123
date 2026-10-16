(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.AddressSearch=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');}
  function create(entries){
    var indexed=entries.map(function(entry){return {entry:entry,text:normalize(entry.s+' '+entry.g+' '+entry.d+' '+entry.p[2])};});
    return {find:function(query,limit){
      var tokens=String(query||'').slice(0,100).trim().split(/\s+/).map(normalize).filter(Boolean),shown=[],total=0,businesses=0;
      if(tokens.join('').length<2)return {entries:shown,total:0,businesses:0,tooShort:true};
      limit=Math.max(1,Math.min(100,Math.floor(Number(limit)||60)));
      indexed.forEach(function(item){if(tokens.every(function(token){return item.text.indexOf(token)>=0;})){
        total++;businesses+=Number(item.entry.p[3])||1;if(shown.length<limit)shown.push(item.entry);
      }});
      return {entries:shown,total:total,businesses:businesses,tooShort:false};
    }};
  }
  return {create:create};
});
