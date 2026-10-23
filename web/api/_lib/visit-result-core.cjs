'use strict';
// Visit outcomes are kept separately from photos. One anonymous slot represents
// one business in the source workbook at an exact address.
const {sha,actor,error,checkAddress}=require('./photo-direct-core.cjs');
const ROOT='현장방문_사업자방문결과_v1';
const KEYS='0123456789abcdef';
const dayInSeoul=milliseconds=>new Intl.DateTimeFormat('en-CA',{
  timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'
}).format(milliseconds);

function createVisitService(core,{now=()=>Date.now()}={}){
  async function shard(key){
    if(typeof key!=='string'||!KEYS.includes(key)||key.length!==1)throw error('INPUT',400,'집계 번호를 확인해 주세요.');
    const root=await core.folder('',ROOT,false);
    if(!root)return {v:1,rows:{}};
    const matches=(await core.list(root)).filter(file=>file.name==='shard-'+key+'.json');
    if(!matches.length)return {v:1,rows:{}};
    if(matches.length!==1||matches[0].type!=='file'||Number(matches[0].size)>8000000)
      throw error('VISIT_DATA',409,'방문 결과 파일을 확인해야 합니다.');
    let data;
    try{data=JSON.parse((await core.readBytes(matches[0])).toString('utf8'));}
    catch(e){if(e.code)throw e;throw error('VISIT_DATA',409,'방문 결과를 읽을 수 없습니다.');}
    if(data?.v!==1||!data.rows||typeof data.rows!=='object'||Array.isArray(data.rows))
      throw error('VISIT_DATA',409,'방문 결과 형식을 확인해야 합니다.');
    return data;
  }
  async function writeShard(key,data){
    const bytes=Buffer.from(JSON.stringify(data));
    if(bytes.length>8000000)throw error('VISIT_DATA',507,'방문 결과 파일이 너무 큽니다.');
    await core.uploadBytes(await core.folder('',ROOT,true),'shard-'+key+'.json',bytes,true);
  }
  function expose(address,location,row,deviceKey){
    let owner='';try{owner=actor(deviceKey);}catch{}
    return {address,...location,businessCount:location.businessCount,
      slots:Array.from({length:location.businessCount},(_,index)=>{
        const item=row?.slots?.[index+1]||null;
        return {businessIndex:index+1,result:item?.result||null,recordedAt:item?.recordedAt||null,
          canEdit:!!owner&&(!item?.result||item.ownerId===owner)};
      })};
  }
  async function status(address,deviceKey){
    const location=checkAddress(address),key=sha(address)[0],data=await shard(key);
    return expose(address,location,data.rows[sha(address)],deviceKey);
  }
  async function save({address,businessIndex,result,deviceKey,adminSession}){
    const location=checkAddress(address);
    if(!Number.isSafeInteger(businessIndex)||businessIndex<1||businessIndex>location.businessCount)
      throw error('BUSINESS',400,'이 주소의 사업자 번호를 다시 선택해 주세요.');
    if(!['refused','completed','clear'].includes(result))
      throw error('RESULT',400,'거절 또는 완료를 선택해 주세요.');
    const admin=!!adminSession;
    if(admin)core.requireAdmin(adminSession);
    const owner=admin?'admin':actor(deviceKey),hash=sha(address),key=hash[0];
    const work=async()=>{
      const data=await shard(key),row=data.rows[hash]||{address,...location,slots:{}},old=row.slots[businessIndex];
      if(old?.result&&old.ownerId!==owner&&!admin)
        throw error('FORBIDDEN',403,'이 결과는 등록한 기기 또는 관리자만 수정할 수 있습니다.');
      const next=result==='clear'?null:result;
      if((old?.result||null)===next)return {saved:false,unchanged:true,...expose(address,location,row,deviceKey)};
      if(!old&&!next)return {saved:false,unchanged:true,...expose(address,location,row,deviceKey)};
      const at=new Date(now()).toISOString();
      row.slots[businessIndex]={result:next,recordedAt:at,day:dayInSeoul(now()),ownerId:owner,
        history:[...(old?.history||[]),{result:next,at,ownerId:owner}].slice(-10)};
      row.updatedAt=at;data.rows[hash]=row;
      await writeShard(key,data);
      return {saved:true,unchanged:false,...expose(address,location,row,deviceKey)};
    };
    for(let attempt=0;attempt<4;attempt++){
      try{return await core.lock('visit-shard:'+key,work);}
      catch(e){if(e.code!=='BUSY'||attempt===3)throw e;
        await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));}
    }
  }
  async function meta(){
    const root=await core.folder('',ROOT,false);
    if(!root)return {keys:[],updatedAt:null};
    const files=await core.list(root);
    if(files.some(file=>file.type!=='file'||!/^shard-[a-f0-9]\.json$/.test(file.name)))
      throw error('VISIT_DATA',409,'방문 결과 폴더를 확인해야 합니다.');
    return {keys:files.map(file=>file.name[6]).sort(),updatedAt:new Date(now()).toISOString()};
  }
  async function chunk(key){
    const data=await shard(key);
    return {rows:Object.values(data.rows).map(row=>({address:row.address,province:row.province,
      district:row.district,dong:row.dong,businessCount:row.businessCount,
      slots:Object.entries(row.slots).map(([index,item])=>({businessIndex:Number(index),result:item.result,
        day:item.day,recordedAt:item.recordedAt}))}))};
  }
  return {status,save,meta,chunk};
}
module.exports={createVisitService,dayInSeoul,ROOT};
