'use strict';
const {timingSafeEqual}=require('node:crypto');
const {createService}=require('./_lib/photo-direct-core.cjs');
const {createVisitService}=require('./_lib/visit-result-core.cjs');

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({ok:false,code:'METHOD'});
  const secret=process.env.CRON_SECRET||'';
  if(!secret)return res.status(503).json({ok:false,code:'SETUP'});
  const supplied=String(req.headers.authorization||'');
  const expected='Bearer '+secret;
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))
    return res.status(401).json({ok:false,code:'AUTH'});
  try{
    const core=createService({token:process.env.MYBOX_TOKEN,adminPassword:process.env.PHOTO_ADMIN_PASSWORD});
    const result=await createVisitService(core).rollup();
    return res.status(200).json({ok:true,...result});
  }catch(e){
    console.warn(JSON.stringify({event:'visit_daily_rollup_failed',code:e.code||'SERVICE',status:e.status||500}));
    return res.status(e.status||500).json({ok:false,code:e.code||'SERVICE'});
  }
};
