const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../web/map-ui.css'),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean).join('\n').replace(/initDataInfo\(\);\s*initMap\(\);\s*$/,'');
function harness(width=390,directEnabled=false){
 const elements=new Map(),events={},calls=[],timers=new Map();let seq=0;
 function element(tag='div'){
  const classes=new Set(),listeners={},e={tagName:tag.toUpperCase(),children:[],attributes:{},dataset:{},hidden:false,open:false,textContent:'',value:'',innerHTML:'',style:{setProperty(k,v){this[k]=v;}},
   classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,force){if(force===undefined)force=!classes.has(c);if(force)classes.add(c);else classes.delete(c);}},
   addEventListener:(name,fn)=>listeners[name]=fn,setAttribute(k,v){this.attributes[k]=v;},append(...nodes){this.children.push(...nodes);},appendChild(node){this.children.push(node);},replaceChildren(...nodes){this.children=nodes;},focus(){this.focused=true;},blur(){this.blurred=true;},showModal(){this.open=true;},close(){this.open=false;},contains:target=>target===e,
   getBoundingClientRect(){return {height:parseFloat(e.style.height)||400,right:416,bottom:84};},listeners};
  Object.defineProperty(e,'innerHTML',{get(){return this.markup||'';},set(value){this.markup=value;this.children=[];}});return e;
 }
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const point=[37.5,127,'서울특별시 영등포구 당산동1가 256-119',3,1,'1123075000','서울'];
 const source={서울특별시:{영등포구:{당산1동:[point]}}};
 const window={ADDR_DATA:source,ADDR_META:{},PHOTO_CONFIG:{webAppUrl:'https://script.google.com/macros/s/test/exec',build:'test',directEnabled},innerWidth:width,innerHeight:844,addEventListener:(name,fn)=>{(events[name]??=[]).push(fn);},AddressSearch:require('../web/address-search.js')};
 const map={setView:(...args)=>calls.push(['setView',...args]),fitBounds:(...args)=>calls.push(['fitBounds',...args]),removeLayer:layer=>calls.push(['removeLayer',layer]),getBounds:()=>({contains:()=>true})};
 const marker={addTo:()=>marker,on:()=>marker,bindPopup(content,options){calls.push(['popup',content,options]);return marker;},openPopup:()=>marker};
 const L={divIcon:options=>options,point:(x,y)=>({x,y}),latLngBounds:pts=>pts,marker:()=>marker};
 const sandbox={window,document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},L,Map,Set,Number,Math,Date,navigator:{},setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id),alert:message=>calls.push(['alert',message])};
 vm.createContext(sandbox);vm.runInContext(script,sandbox);sandbox.map=map;sandbox.cluster={clearLayers(){},addLayers(){}};sandbox.buildIndex();
 return {ui:sandbox,get,events,calls,point,timers};
}
test('map uses the photo-page palette and keeps secondary actions inside the more menu',()=>{
 assert.match(html,/map-ui\.css\?v=20261020-progress/);assert.match(css,/--accent:#2563eb/);assert.doesNotMatch(css,/#EFEBE3|#E5007E|#FF6A00|animation:(?:spread|ripple)/i);
 const menu=html.slice(html.indexOf('<details class="map-menu"'),html.indexOf('</details>'));
 for(const token of ['duplicates.html','coordinate-review.html','dataInfoBtn','photoAdminLink','nApprox'])assert.ok(menu.includes(token));
 assert.match(menu,/지도에 표시된 숫자는 주소 수/);assert.match(html,/id="panelToggle"[^>]*aria-expanded="true"/);
});
test('direct-photo map links to local registration and administration, not Apps Script',()=>{
 const h=harness(390,true);
 assert.equal(h.get('photoAdminLink').href,'/photo-admin');
 const url=new URL(h.ui.photoUrl(h.point[2]),'https://rep123-seven.vercel.app/');
 assert.equal(url.pathname,'/photo');assert.equal(url.searchParams.get('address'),h.point[2]);
});
test('panel can be collapsed and reopened with a native button without losing region or search state',()=>{
 const h=harness();h.ui.sel.sido='서울특별시';h.get('mapSearch').value='당산동';h.ui.setPanel(h.ui.defaultH());
 assert.equal(h.get('panelContent').hidden,false);h.get('panelToggle').onclick({stopPropagation(){}});
 assert.equal(h.get('panelContent').hidden,true);assert.equal(h.get('panelToggle').attributes['aria-expanded'],'false');assert.equal(h.get('panelToggle').textContent,'목록 열기');
 assert.equal(h.get('map').style['--map-footer-bottom'],'60px');h.get('panelToggle').onclick({stopPropagation(){}});
 assert.equal(h.get('panelContent').hidden,false);assert.equal(h.get('panelToggle').attributes['aria-expanded'],'true');
 assert.equal(h.ui.sel.sido,'서울특별시');assert.equal(h.get('mapSearch').value,'당산동');
});
test('desktop panel and map framing respect the left sidebar, while mobile avoids the bottom sheet',()=>{
 const desktop=harness(1200);desktop.ui.setPanel(desktop.ui.defaultH());assert.equal(desktop.get('panel').style.height,'716px');
 assert.equal(desktop.get('map').style['--map-footer-bottom'],'4px');assert.equal(desktop.ui.mapInsets().topLeft.x,432);assert.equal(desktop.ui.mapInsets().bottomRight.y,16);
 const mobile=harness();mobile.ui.setPanel(400);assert.equal(mobile.ui.mapInsets().topLeft.y,96);assert.equal(mobile.ui.mapInsets().bottomRight.y,416);
 mobile.ui.collapsePanel();assert.equal(mobile.ui.mapInsets().bottomRight.y,72);
 desktop.ui.fitToRecords([desktop.point,[37.6,127.1,'다른 주소',1]]);assert.equal(desktop.calls.at(-1)[2].paddingTopLeft.x,432);
});
test('address rows separate map selection from photo navigation and preserve the exact raw address',()=>{
 const h=harness();h.ui.appendAddrRow(h.point);const row=h.get('list').children[0],select=row.children[0],photo=row.children[2];
 assert.equal(row.tagName,'ARTICLE');assert.equal(select.tagName,'BUTTON');assert.equal(select.textContent,h.point[2]);
 assert.ok(!row.attributes.role,'do not nest a photo link in a button-like address row');
 assert.equal(new URL(photo.href,'https://example.test').searchParams.get('address'),h.point[2]);assert.equal(photo.rel,'noopener noreferrer');
 assert.match(row.children[1].innerHTML,/사업자수 3개/);select.onclick();assert.equal(h.get('panelContent').hidden,true);
 assert.equal(h.calls.find(c=>c[0]==='setView')[2],18);assert.match(h.calls.find(c=>c[0]==='popup')[1],/popup-links/);
});
test('coordinate warnings and missing coordinates remain explicit, without blocking photo links',()=>{
 const h=harness(),approx=[37,127,'테스트 <주소>',2,0,'','서울'];h.ui.appendAddrRow(approx);
 assert.match(h.get('list').children[0].children[1].innerHTML,/좌표 확인필요/);assert.match(h.get('list').children[0].children[1].innerHTML,/행정동 미확정/);
 h.ui.openPopup({bindPopup(content){assert.match(content,/&lt;주소&gt;/);assert.match(content,/근사 좌표/);return {openPopup(){}};}},approx);
 h.ui.appendAddrRow([null,null,'좌표 없음',1,0]);const missing=h.get('list').children[1];missing.children[0].onclick();assert.equal(h.calls.at(-1)[0],'alert');assert.ok(missing.children[2].href);
});
test('two stored photos turn a verified address green while coordinate warnings remain visible',()=>{
 const h=harness(),rec=h.ui.recordByPoint.get(h.point);
 assert.match(h.ui.markerIcon(rec).html,/addr-dot/);
 assert.doesNotMatch(h.ui.markerIcon(rec).html,/completed/);
 h.ui.applyPhotoCount(h.point[2],2);
 assert.match(h.ui.markerIcon(rec).html,/addr-dot completed/);
 h.ui.appendAddrRow(h.point);
 assert.equal(h.get('list').children[0].children[2].textContent,'등록 완료 · 사진 보기');
 const warning=[37,127,'좌표 경고 주소',1,0,'','서울'];
 h.ui.applyPhotoCount(warning[2],2);
 assert.match(h.ui.markerIcon({p:warning,real:false}).html,/addr-dot approx completed/);
 assert.match(css,/\.addr-dot\.completed\.approx/);
});

test('mismatched addresses show a permanent marker label and escaped source-result warning without blocking photos',()=>{
 const h=harness(),p=h.point;h.ui.window.COORD_REVIEW={records:{[p[2]]:{status:'address-mismatch',matchedAddress:'다른 번지 <안전>',note:'원주소 보존'}}};
 assert.equal(h.ui.coordinateNeedsReview(p),true);assert.equal(h.ui.coordinateLabel(p),'주소 불일치');
 h.ui.appendAddrRow(p);assert.match(h.get('list').children[0].children[1].innerHTML,/주소 불일치/);assert.ok(h.get('list').children[0].children[2].href);
 h.ui.openPopup({bindPopup(content){assert.match(content,/원주소와 지도 검색 결과 불일치/);assert.match(content,/다른 번지 &lt;안전&gt;/);assert.match(content,/현장 사진 등록/);return {openPopup(){}};}},p);
 assert.match(html,/map-pin-label/);assert.match(css,/\.addr-dot\.mismatch/);
});
test('complex representative points remain warned on the marker and in its popup',()=>{
 const h=harness(),p=h.point;p[4]=0;h.ui.window.COORD_REVIEW={records:{[p[2]]:{status:'representative-only',matchedAddress:'동탄영천로 150',note:'S01동은 미확정'}}};
 assert.equal(h.ui.coordinateNeedsReview(p),true);assert.equal(h.ui.coordinateLabel(p),'건물·필지 대표 위치 · 상세 위치 미확인');h.ui.appendAddrRow(p);
 assert.match(h.get('list').children[0].children[1].innerHTML,/건물·필지 대표 위치/);assert.ok(h.get('list').children[0].children[2].href);
 h.ui.openPopup({bindPopup(content){assert.match(content,/건물·필지 대표 위치 · 상세 위치 미확인/);assert.match(content,/S01동은 미확정/);return {openPopup(){}};}},p);
});
test('region drilldown keeps weighted business counts and keyboard-accessible breadcrumb buttons',()=>{
 const h=harness();h.ui.renderSido();const region=h.get('list').children.find(r=>r.attributes.role==='button');
 assert.equal(region.attributes['aria-label'],'서울특별시 사업자수 3개');region.onclick();assert.equal(h.ui.sel.sido,'서울특별시');
 assert.match(h.get('crumb').innerHTML,/<button type="button"/);assert.match(h.get('crumb').innerHTML,/aria-current="location"/);
 h.ui.sel.gugun='영등포구';h.ui.renderDong();h.ui.sel.dong='당산1동';h.ui.renderAddr();assert.equal(h.get('list').children.at(-1).tagName,'ARTICLE');
 assert.match(h.get('crumb').innerHTML,/당산1동/);assert.equal(h.ui.countSido(h.ui.DATA['서울특별시']),3);
});
test('global search and clearing keep raw-address photo links and the selected scope',()=>{
 const h=harness();h.ui.sel={sido:'서울특별시',gugun:'영등포구',dong:'당산1동'};h.get('mapSearch').value='당산동';h.ui.renderSearch(true);
 assert.equal(h.ui.searchMode,true);assert.equal(h.get('clearMapSearch').hidden,false);assert.match(h.get('list').children[0].textContent,/1곳 · 사업자 3개/);
 assert.equal(h.get('list').children[1].children[0].textContent,h.point[2]);h.ui.clearSearch();assert.equal(h.ui.searchMode,false);assert.equal(h.ui.sel.dong,'당산1동');assert.equal(h.get('clearMapSearch').hidden,true);
});
test('changing scope clears the old selected popup and resets the list scroll position',()=>{
 const h=harness(),selected={test:'selected marker'};h.ui.selMarker=selected;h.get('list').scrollTop=800;
 h.ui.showMarkers(null,'ALL');assert.equal(h.ui.selMarker,null);assert.equal(h.calls.find(c=>c[0]==='removeLayer')[1],selected);
 h.ui.clearList();assert.equal(h.get('list').scrollTop,0);assert.match(html,/lyrs=m&hl=ko&/);
});
test('resizing to mobile settles at the mobile height and keyboard resizing does not overwrite the preferred height',()=>{
 const h=harness(1200);h.ui.setPanel(h.ui.defaultH());
 h.ui.window.innerWidth=320;h.events.resize[0]();h.ui.window.innerHeight=740;h.events.resize[0]();
 assert.equal(h.timers.size,1);[...h.timers.values()][0]();assert.equal(h.get('panel').style.height,'355px');
 h.ui.window.innerHeight=320;h.events.resize[0]();[...h.timers.values()].at(-1)();assert.equal(h.get('panel').style.height,'355px');
 assert.equal(h.get('map').style['--map-footer-bottom'],'224px');
});
test('more menu closes on Escape and outside click; merely opening the page never requests GPS',()=>{
 const h=harness(),menu=h.get('mapMenu');menu.open=true;h.events.keydown[0]({key:'Escape'});assert.equal(menu.open,false);assert.equal(h.get('menuTrigger').focused,true);
 menu.open=true;h.events.pointerdown[0]({target:{}});assert.equal(menu.open,false);assert.equal(h.calls.some(c=>c[0]==='alert'),false);
});
