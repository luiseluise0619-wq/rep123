const test=require('node:test'),assert=require('node:assert/strict');
const {harness,ADDRESS,fakeJpeg}=require('./helpers/photo-harness.cjs');

test('normal pending repair never starts a full scan and does no storage writes when nothing changed',()=>{
 const h=harness();const before=h.calls(),files=h.resources.length;
 const result=h.app.repairAdminCatalog(h.session);
 assert.equal(result.ok,true);assert.equal(result.data.pending,0);assert.equal(result.data.processed,0);
 assert.equal(h.calls(),before);assert.equal(h.resources.length,files);assert.equal(h.props.has('PHOTO_SCAN_V3'),false);
});

test('an empty address folder does not create an empty shard or rewrite the manifest',()=>{
 const h=harness();h.app.rpc_(()=>h.app.markCatalogPending_(ADDRESS));
 assert.equal(h.app.repairAdminCatalog(h.session).ok,true);
 assert.equal(h.resources.filter(r=>r.name.endsWith('.json')).length,0);
 assert.equal(h.app.getAdminOverview(h.session).data.pending,0);
});

test('sixteen empty shards finish pruning in one RPC without rewriting any shard',()=>{
 const h=harness();h.app.rpc_(()=>{const m=h.app.manifest_();for(let i=0;i<16;i++)h.app.saveShard_(i.toString(16),{v:3,rows:{}},m);m.scanComplete=false;h.app.indexWrite_('manifest.json',m);});
 const ids=h.resources.filter(r=>/^shard-/.test(r.name)).map(r=>r.resourceId).sort();
 h.props.set('PHOTO_SCAN_V3',JSON.stringify({active:true,id:'speed-test',phase:'prune',prune:0,processed:1,issues:0,startedAt:new Date().toISOString()}));
 const before=h.calls(),result=h.app.syncAdminCatalog(h.session,false),calls=h.calls()-before;
 assert.equal(result.ok,true);assert.equal(result.data.scan.active,false);assert.equal(result.data.scan.phase,'done');
 assert.deepEqual(h.resources.filter(r=>/^shard-/.test(r.name)).map(r=>r.resourceId).sort(),ids);
 assert.ok(calls<=12,'empty pruning must not make sixteen network round trips, got '+calls);
 const overview=h.app.getAdminOverview(h.session).data;assert.equal(overview.photos,0);assert.equal(overview.scanComplete,true);assert.ok(overview.verifiedAt);
});

test('pending repair restores a saved photo without scanning unrelated folders or losing evidence',()=>{
 const h=harness();h.failCatalog(true);
 const saved=h.app.uploadPhoto(h.session,ADDRESS,{base64:fakeJpeg().toString('base64'),visitDate:'2026-10-16',confirmReadable:true,publicShare:true});
 assert.equal(saved.ok,true);assert.equal(saved.data.catalogPending,true);h.failCatalog(false);
 const repaired=h.app.repairAdminCatalog(h.session);assert.equal(repaired.ok,true);assert.equal(repaired.data.pending,0);
 const overview=h.app.getAdminOverview(h.session).data;assert.equal(overview.addresses,1);assert.equal(overview.photos,1);
 assert.equal(h.resources.filter(r=>r.name.endsWith('.jpg')).length,1);assert.equal(h.props.has('PHOTO_SCAN_V3'),false);
});
