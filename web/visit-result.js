(function(){
'use strict';
const $=id=>document.getElementById(id);
const address=new URLSearchParams(location.search).get('address')||'';
const labels={refused:'거절',completed:'완료'};
let data=null,busy=false;
function note(text,error=false){
  const target=$('visitResultMessage');target.textContent=text;target.hidden=!text;
  target.className=error?'message error':'small';
}
function deviceKey(){
  try{const key=localStorage.getItem('photoDeviceKeyV4')||'';return /^[a-f0-9]{64}$/.test(key)?key:'';}
  catch{return '';}
}
async function api(action,fields){
  let response;
  try{response=await fetch('/api/photo-direct',{method:'POST',cache:'no-store',referrerPolicy:'no-referrer',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...fields}),signal:AbortSignal.timeout(90000)});}
  catch{throw Error('연결이 늦습니다. 잠시 후 다시 시도해 주세요.');}
  const value=await response.json();
  if(!response.ok||!value.ok)throw Error(value.message||'방문 결과를 확인하지 못했습니다.');
  return value.data;
}
function render(){
  if(!data)return;
  $('visitResultHint').textContent=data.businessCount===1?'이 주소의 사업자 1곳에 대한 결과입니다.':
    '사업자 '+data.businessCount+'곳입니다. 번호는 임시 구분용이니 같은 사업자는 계속 같은 번호를 선택해 주세요.';
  const list=$('visitResultList');list.replaceChildren();
  for(const slot of data.slots){
    const item=document.createElement('div'),head=document.createElement('div'),name=document.createElement('strong'),state=document.createElement('span'),actions=document.createElement('div');
    item.className='visit-item';item.dataset.result=slot.result||'';head.className='head';actions.className='actions';
    name.textContent=data.businessCount===1?'사업자':'사업자 '+slot.businessIndex;
    state.className='small visit-state';state.textContent=slot.result?labels[slot.result]+' · '+new Date(slot.recordedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'미기록';
    head.append(name,state);
    for(const result of ['refused','completed']){
      const button=document.createElement('button');button.type='button';button.textContent=labels[result];button.dataset.result=result;
      button.setAttribute('aria-pressed',String(slot.result===result));
      button.disabled=busy||!slot.canEdit||slot.result===result;
      button.onclick=()=>save(slot.businessIndex,result);
      actions.append(button);
    }
    if(slot.result&&slot.canEdit){
      const clear=document.createElement('button');clear.type='button';clear.className='clear';clear.textContent='기록 취소';clear.disabled=busy;
      clear.onclick=()=>save(slot.businessIndex,'clear');actions.append(clear);
    }
    item.append(head,actions);
    if(slot.result&&!slot.canEdit){const help=document.createElement('p');help.className='small';help.textContent='다른 기기에서 등록했습니다. 변경은 등록한 기기 또는 관리자에게 요청해 주세요.';item.append(help);}
    list.append(item);
  }
}
async function save(businessIndex,result){
  if(busy)return;
  if(!deviceKey()){note('이 브라우저의 저장 기능을 허용한 뒤 다시 열어 주세요.',true);return;}
  busy=true;render();note('방문 결과 저장 중…');
  try{
    const response=await api('visitSave',{address,businessIndex,result,deviceKey:deviceKey()});
    data=response;note(result==='clear'?'기록을 취소했습니다. 일별 집계에도 포함되지 않습니다.':'사업자 '+businessIndex+' · '+labels[result]+'로 저장했습니다.');
  }catch(error){note(error.message,true);try{data=await api('visitStatus',{address,deviceKey:deviceKey()});}catch{}}
  finally{busy=false;render();}
}
$('openVisitResults').onclick=async()=>{
  const panel=$('visitResultPanel'),opening=panel.hidden;
  panel.hidden=!opening;$('openVisitResults').setAttribute('aria-expanded',String(opening));
  $('openVisitResults').textContent=opening?'접기':'결과 기록';
  if(!opening||data)return;
  if(!address){note('지도에서 방문 주소를 선택해 주세요.',true);return;}
  note('방문 결과 확인 중…');
  try{data=await api('visitStatus',{address,deviceKey:deviceKey()});note('');render();}
  catch(error){note(error.message,true);}
};
})();
