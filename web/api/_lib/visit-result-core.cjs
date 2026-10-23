'use strict';
// Visit outcomes are kept separately from photos. One anonymous slot represents
// one business in the source workbook at an exact address.
const {sha,actor,error,checkAddress}=require('./photo-direct-core.cjs');
const ROOT='현장방문_사업자방문결과_v1';
const ARCHIVE_ROOT='현장방문_일별집계_v1';
const ARCHIVE_JSON='일별집계.json';
const ARCHIVE_XLSX='방문결과_일별집계.xlsx';
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
      const timestamp=now(),at=new Date(timestamp).toISOString();
      // One final result per business and Seoul day is enough for stable daily totals.
      const day=dayInSeoul(timestamp),dayHistory={...(old?.dayHistory||{})};
      for(const event of old?.history||[]){
        const when=Date.parse(event.at);
        if(!Number.isFinite(when))continue;
        const eventDay=dayInSeoul(when);
        if(!dayHistory[eventDay]||event.at>dayHistory[eventDay].at)
          dayHistory[eventDay]={result:event.result,at:event.at};
      }
      dayHistory[day]={result:next,at};
      row.slots[businessIndex]={result:next,recordedAt:at,day,ownerId:owner,
        dayHistory,history:[...(old?.history||[]),{result:next,at,ownerId:owner}].slice(-10)};
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
  async function archive(){
    const root=await core.folder('',ARCHIVE_ROOT,false);
    if(!root)return {v:1,days:{}};
    const matches=(await core.list(root)).filter(file=>file.name===ARCHIVE_JSON);
    if(!matches.length)return {v:1,days:{}};
    if(matches.length!==1||matches[0].type!=='file'||Number(matches[0].size)>8000000)
      throw error('VISIT_DATA',409,'일별 집계 파일을 확인해야 합니다.');
    let data;
    try{data=JSON.parse((await core.readBytes(matches[0])).toString('utf8'));}
    catch(e){if(e.code)throw e;throw error('VISIT_DATA',409,'일별 집계를 읽을 수 없습니다.');}
    if(data?.v!==1||!data.days||typeof data.days!=='object'||Array.isArray(data.days))
      throw error('VISIT_DATA',409,'일별 집계 형식을 확인해야 합니다.');
    for(const [day,counts] of Object.entries(data.days)){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isSafeInteger(counts?.refused)||counts.refused<0||
         !Number.isSafeInteger(counts?.completed)||counts.completed<0)
        throw error('VISIT_DATA',409,'일별 집계 값을 확인해야 합니다.');
    }
    return data;
  }
  function eventDays(rows,through){
    const byDay=new Map();let earliest='';
    for(const row of rows)for(const [index,slot] of Object.entries(row.slots||{})){
      const history=slot.dayHistory&&typeof slot.dayHistory==='object'?
        Object.values(slot.dayHistory):Array.isArray(slot.history)&&slot.history.length?slot.history:
          slot.recordedAt?[{at:slot.recordedAt,result:slot.result}]:[];
      for(const event of history){
        const milliseconds=Date.parse(event.at);
        if(!Number.isFinite(milliseconds)||!['refused','completed',null].includes(event.result))continue;
        const day=dayInSeoul(milliseconds);if(day>through)continue;
        if(!earliest||day<earliest)earliest=day;
        if(!byDay.has(day))byDay.set(day,new Map());
        const bucket=byDay.get(day),id=row.address+'\n'+index,prior=bucket.get(id);
        if(!prior||event.at>prior.at)bucket.set(id,event);
      }
    }
    return {byDay,earliest};
  }
  function daysBetween(start,end){
    const days=[];let date=Date.parse(start+'T00:00:00Z');const last=Date.parse(end+'T00:00:00Z');
    while(date<=last&&days.length<36600){days.push(new Date(date).toISOString().slice(0,10));date+=86400000;}
    return days;
  }
  function archiveWorkbook(days){
    const {makeWorkbook}=require('../../visit-xlsx.js');
    let totalRefused=0,totalCompleted=0;
    const rows=[['날짜','거절 사업자','완료 사업자','일일 합계','누적 거절','누적 완료','누적 합계']];
    for(const day of Object.keys(days).sort()){
      const item=days[day];totalRefused+=item.refused;totalCompleted+=item.completed;
      rows.push([new Date(day+'T00:00:00Z'),item.refused,item.completed,item.refused+item.completed,
        totalRefused,totalCompleted,totalRefused+totalCompleted]);
    }
    return Buffer.from(makeWorkbook([{name:'일별집계',rows}]));
  }
  async function rollup(){
    const today=dayInSeoul(now()),yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    return core.lock('visit-daily-rollup',async()=>{
      const data=await archive(),keys=(await meta()).keys;
      const batches=await Promise.all(keys.map(key=>shard(key)));
      const rows=batches.flatMap(batch=>Object.values(batch.rows));
      const events=eventDays(rows,yesterday);
      const firstArchived=Object.keys(data.days).sort()[0];
      const start=[firstArchived,events.earliest,yesterday].filter(Boolean).sort()[0];
      let added=0;
      for(const day of daysBetween(start,yesterday)){
        if(Object.hasOwn(data.days,day))continue;
        const values=[...(events.byDay.get(day)?.values()||[])];
        data.days[day]={refused:values.filter(value=>value.result==='refused').length,
          completed:values.filter(value=>value.result==='completed').length};
        added++;
      }
      const root=await core.folder('',ARCHIVE_ROOT,true);
      if(added)await core.uploadBytes(root,ARCHIVE_JSON,Buffer.from(JSON.stringify(data)),true);
      await core.uploadBytes(root,ARCHIVE_XLSX,archiveWorkbook(data.days),true,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return {through:yesterday,added,days:Object.keys(data.days).length};
    });
  }
  return {status,save,meta,chunk,archive,rollup};
}
module.exports={createVisitService,dayInSeoul,ROOT,ARCHIVE_ROOT};
