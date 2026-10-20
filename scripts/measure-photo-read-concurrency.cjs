// Read-only production probe. It never uploads, modifies, or deletes a photo.
const path=require('node:path');
const {chromium}=require('playwright');
const addresses=[
  '서울특별시 영등포구 당산동1가 256-119',
  '서울특별시 동대문구 외대역동로27길 47, 201동(이문동)',
  '서울특별시 중구 을지로5가 19-43'
];
const config={webAppUrl:'https://script.google.com/macros/s/AKfycbxkluXWRelyVJ1D0XtuLHHo1GdF76Dzp4CLHQeC-hlvpW6WmctvD9_60WKqugmfN_PAQw/exec',build:'read-only-probe'};
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.goto('https://rep123-seven.vercel.app/coordinate-review',{waitUntil:'domcontentloaded',timeout:45000});
    await page.addScriptTag({path:path.join(__dirname,'../web/photo-progress.js')});
    const result=await page.evaluate(async ({addresses,config})=>{
      const service=window.PhotoMapProgress.create(config,()=>{},()=>{});
      if(!service)return {error:'bridge configuration rejected'};
      const measure=async address=>{const start=performance.now();try{const count=await service.check(address);return {ok:true,count,ms:Math.round(performance.now()-start)};}
        catch(error){return {ok:false,code:error.code||'',message:error.message,ms:Math.round(performance.now()-start)};}};
      const single=await measure(addresses[0]);
      const start=performance.now(),parallel=await Promise.all(addresses.map(measure));
      return {single,parallel,parallelWallMs:Math.round(performance.now()-start)};
    },{addresses,config});
    console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
