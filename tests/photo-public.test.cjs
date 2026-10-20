const test=require('node:test'),assert=require('node:assert/strict');
const {harness,fakeJpeg,ADDRESS}=require('./helpers/photo-harness.cjs');
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const photo=(seed=1)=>({base64:fakeJpeg(seed).toString('base64'),visitDate:'2026-01-01',confirmReadable:true,publicShare:true});
test('anyone can upload and read; no owner secret, filename or private uploader data is disclosed',()=>{
  const h=harness(),upload=h.app.uploadPublicPhoto(A,ADDRESS,photo());assert.equal(upload.ok,true);
  const id=upload.data.photo.id,status=h.app.getPublicStatus(ADDRESS,'');
  assert.equal(status.ok,true);assert.equal(status.data.photos.length,1);assert.equal(status.data.photos[0].canDelete,false);
  assert.equal(h.app.getPublicPhoto(ADDRESS,id).ok,true);
  assert.equal(h.app.getPublicStatus(ADDRESS,A).data.photos[0].canDelete,true);
  assert.equal(h.app.getPublicStatus(ADDRESS,B).data.photos[0].canDelete,false);
  const serialized=JSON.stringify(status);for(const forbidden of [A,'v4d-','ownerId','resourceId','uploader','fileName'])assert.ok(!serialized.includes(forbidden));
  assert.ok(!JSON.stringify(h.resources).includes(A),'raw device key must never be stored upstream');
});
test('public consent, cryptographic device key, valid source address and two-address-wide slots are enforced',()=>{
  const h=harness();
  assert.equal(h.app.uploadPublicPhoto('',ADDRESS,photo()).code,'DEVICE');
  assert.equal(h.app.uploadPublicPhoto('admin',ADDRESS,photo()).code,'DEVICE');
  assert.equal(h.app.uploadPublicPhoto(A,ADDRESS,{...photo(),publicShare:false}).code,'PUBLIC_CONSENT');
  assert.equal(h.app.uploadPhoto(h.session,ADDRESS,{...photo(),publicShare:false}).code,'PUBLIC_CONSENT','old cached private UI cannot silently upload public photos');
  assert.equal(h.app.uploadPublicPhoto(A,'not a source address',photo()).code,'ADDRESS');
  assert.equal(h.app.uploadPublicPhoto(A,ADDRESS,photo(1)).ok,true);
  assert.equal(h.app.uploadPublicPhoto(A,ADDRESS,photo(1)).data.alreadySaved,true);
  assert.equal(h.app.uploadPublicPhoto(B,ADDRESS,photo(1)).code,'DUPLICATE');
  assert.equal(h.app.uploadPublicPhoto(B,ADDRESS,photo(2)).ok,true);
  assert.equal(h.app.uploadPublicPhoto(C,ADDRESS,photo(3)).code,'FULL');
});
test('only uploading browser or valid admin can delete; destination is scoped JPEG Trash, not permanent delete',()=>{
  const h=harness(),a=h.app.uploadPublicPhoto(A,ADDRESS,photo(1)).data.photo,b=h.app.uploadPublicPhoto(B,ADDRESS,photo(2)).data.photo;
  for(const key of ['',B,C])assert.equal(h.app.deletePhoto('',key,ADDRESS,a.id).ok,false);
  const staff=h.staff('staff-a');assert.equal(h.app.deletePhoto(staff.session,A,ADDRESS,a.id).code,'FORBIDDEN');
  assert.equal(h.trash.length,0);
  assert.equal(h.app.deletePhoto('',A,ADDRESS,a.id).ok,true);assert.equal(h.trash.length,1);
  assert.equal(h.app.getPublicPhoto(ADDRESS,a.id).code,'NOT_FOUND');assert.equal(h.app.getPublicPhoto(ADDRESS,b.id).ok,true);
  assert.equal(h.app.getAdminOverview(h.session).data.photos,1);
  assert.equal(h.app.deletePhoto(h.session,'',ADDRESS,b.id).ok,true);
  assert.equal(h.app.getAdminOverview(h.session).data.photos,0);assert.equal(h.app.getAdminOverview(h.session).data.addresses,0);
  assert.equal(h.trash.length,2);assert.ok(h.trash.every(f=>f.type==='file'&&f.name.endsWith('.jpg')));
});
test('a stale deletion ID never deletes a replacement photo in the reused slot',()=>{
  const h=harness(),old=h.app.uploadPublicPhoto(A,ADDRESS,photo()).data.photo;
  h.app.deletePhoto('',A,ADDRESS,old.id);
  const fresh=h.app.uploadPublicPhoto(A,ADDRESS,photo()).data.photo;assert.notEqual(fresh.id,old.id);
  assert.equal(h.app.deletePhoto('',A,ADDRESS,old.id).data.alreadyDeleted,true);
  assert.equal(h.app.getPublicPhoto(ADDRESS,fresh.id).ok,true);assert.equal(h.trash.length,1);
  const raw=h.resources.find(f=>f.name&&f.name.endsWith('.jpg')).resourceId;
  assert.equal(h.app.deletePhoto('',A,ADDRESS,raw).code,'PHOTO_ID');
});
test('old account-owned photos remain visible publicly but cannot be deleted by a new browser',()=>{
  const h=harness(),staff=h.staff('staff-a'),old=h.app.uploadPhoto(staff.session,ADDRESS,photo()).data.photo;
  assert.equal(h.app.getPublicPhoto(ADDRESS,old.id).ok,true);
  assert.equal(h.app.deletePhoto('',A,ADDRESS,old.id).code,'FORBIDDEN');
  assert.equal(h.app.deletePhoto(h.session,'',ADDRESS,old.id).ok,true);
});
test('ambiguous deletion is not misreported as reversible rollback; retry and catalog recovery are safe',()=>{
  const h=harness(),p=h.app.uploadPublicPhoto(A,ADDRESS,photo()).data.photo;
  h.dropNextDeleteResponse();const failed=h.app.deletePhoto('',A,ADDRESS,p.id);
  assert.equal(failed.ok,false);assert.ok(!JSON.stringify(failed).includes('SECRET'));assert.equal(h.trash.length,1);
  assert.equal(h.app.getPublicStatus(ADDRESS,A).data.totalCount,0);
  assert.equal(h.app.deletePhoto('',A,ADDRESS,p.id).data.alreadyDeleted,true);
  assert.equal(h.app.getAdminOverview(h.session).data.pending,1);
  for(let i=0;i<25;i++)h.app.syncAdminCatalog(h.session,false);
  const result=h.app.getAdminOverview(h.session).data;assert.equal(result.photos,0);assert.equal(result.pending,0);
});
test('public feature gate and storage ceiling remain closed when disabled/exhausted',()=>{
  const h=harness();h.app.PHOTO_LIMITS_={...h.app.PHOTO_LIMITS_,publicEnabled:false};
  assert.equal(h.app.getPublicStatus(ADDRESS,A).code,'CLOSED');assert.equal(h.app.uploadPublicPhoto(A,ADDRESS,photo()).code,'CLOSED');
  h.app.PHOTO_LIMITS_={...h.app.PHOTO_LIMITS_,publicEnabled:true};h.setUsed(24000000000);
  assert.equal(h.app.uploadPublicPhoto(A,ADDRESS,photo()).code,'STORAGE');
});
