// Isolated browser-to-MYBOX feasibility test. Never used for field visits.
// MYBOX_TOKEN and MYBOX_DIRECT_PROBE_KEY are Vercel server environment variables.
const {randomUUID, timingSafeEqual, createHash} = require('node:crypto');
const {createService, validJpeg} = require('./_lib/photo-direct-core.cjs');

const ROOT = '연결점검_현장방문아님';
const LOCK_ROOT = '직접전송_잠금점검';
const PIPE_ROOT = '직접전송_저장단계점검';
const PREFIX = 'DIRECT_BROWSER_TEST_NOT_A_FIELD_VISIT__';
const API = 'https://open-api.mybox.naver.com/v1';

function failure(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
function authorized(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || expected.length < 12) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validName(name) {
  return typeof name === 'string' && /^DIRECT_BROWSER_TEST_NOT_A_FIELD_VISIT__[0-9a-f-]{36}\.jpg$/.test(name);
}
async function mybox(path, method = 'GET', body) {
  const token = String(process.env.MYBOX_TOKEN || '').trim().replace(/^Bearer\s+/i, '').trim();
  const response = await fetch(API + path, {
    method, redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: {Authorization: 'Bearer ' + token,
      ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
  if (response.status === 401)
    throw failure('MYBOX_AUTH', 502, 'MYBOX 토큰 인증 실패(401). Vercel의 MYBOX_TOKEN 값과 유효기간을 확인하고 재배포해 주세요.');
  if (!response.ok) throw failure('MYBOX', 502, 'MYBOX 요청이 실패했습니다. HTTP ' + response.status);
  if (response.status === 204) return {};
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw failure('MYBOX_RESPONSE', 502, 'MYBOX 응답을 읽지 못했습니다.'); }
}
async function items(parent = '') {
  const all = [];
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const path = parent ? '/drive/folders/' + encodeURIComponent(parent) + '/resources' : '/drive/resources';
    const result = await mybox(path + '?count=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!Array.isArray(result.resources)) throw failure('MYBOX_RESPONSE', 502, 'MYBOX 목록 형식을 확인할 수 없습니다.');
    all.push(...result.resources);
    cursor = result.responseMetaData && result.responseMetaData.nextCursor || '';
    if (!cursor) return all;
  }
  throw failure('MYBOX_RESPONSE', 502, '점검 폴더의 항목이 너무 많습니다.');
}
async function probeFolder(create) {
  const matches = (await items()).filter(item => item.name === ROOT);
  if (matches.length > 1 || matches.length && matches[0].type !== 'folder')
    throw failure('FOLDER', 409, '점검 폴더 이름이 중복됩니다.');
  if (matches.length) return matches[0].resourceId;
  if (!create) return null;
  const result = await mybox('/drive/folders', 'POST', {folderName: ROOT});
  if (!result.resourceId) throw failure('FOLDER', 502, '점검 폴더를 만들지 못했습니다.');
  return result.resourceId;
}
async function checkFolderLock() {
  const parent = await probeFolder(true);
  let matches = (await items(parent)).filter(item => item.name === LOCK_ROOT);
  if (matches.length > 1 || matches.length && matches[0].type !== 'folder')
    throw failure('FOLDER', 409, '잠금 점검 폴더가 중복됩니다.');
  let folderId = matches[0]?.resourceId;
  if (!folderId) {
    try { folderId = (await mybox('/drive/folders', 'POST', {parentId: parent, folderName: LOCK_ROOT})).resourceId; }
    catch (error) {
      if (error.code !== 'MYBOX' || !error.message.includes('409')) throw error;
      matches = (await items(parent)).filter(item => item.name === LOCK_ROOT && item.type === 'folder');
      if (matches.length !== 1) throw failure('FOLDER', 409, '잠금 점검 폴더를 확인할 수 없습니다.');
      folderId = matches[0].resourceId;
    }
  }
  if (!folderId) throw failure('FOLDER', 502, '잠금 점검 폴더를 만들지 못했습니다.');
  const name = 'LOCK_TEST_NOT_A_FIELD_VISIT__' + randomUUID();
  const attempts = await Promise.all(Array.from({length: 2}, async () => {
    try { const item = await mybox('/drive/folders', 'POST', {parentId: folderId, folderName: name});
      return {status: 201, id: item.resourceId || ''}; }
    catch (error) { return {status: error.code === 'MYBOX' && error.message.includes('409') ? 409 : 0, code: error.code || 'SERVICE'}; }
  }));
  const created = (await items(folderId)).filter(item => item.name === name);
  const ids = new Set([...attempts.map(item => item.id).filter(Boolean), ...created.map(item => item.resourceId)]);
  let trashed = 0;
  for (const id of ids) {
    try { await mybox('/drive/resources/' + encodeURIComponent(id), 'DELETE'); trashed++; }
    catch (error) { console.warn(JSON.stringify({event:'mybox_lock_test_cleanup_failed',code:error.code||'SERVICE'})); }
  }
  return {atomic: attempts.filter(item => item.status === 201).length === 1 &&
    attempts.filter(item => item.status === 409).length === 1 && created.length === 1 && trashed === ids.size,
    statuses: attempts.map(item => item.status), sameNameFolders: created.length, trashed, cleanupNeeded: trashed !== ids.size};
}
async function checkSavePipeline(name) {
  const parent = await probeFolder(false);
  const matches = parent ? (await items(parent)).filter(item => item.name === name) : [];
  if (matches.length !== 1 || matches[0].type !== 'file')
    throw failure('FILE', 409, '업로드된 점검 사진 1장을 확인해 주세요.');
  const file = matches[0], service = createService({token:process.env.MYBOX_TOKEN});
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const renamed = PREFIX + randomUUID() + '.jpg';
  const indexName = 'CATALOG_TEST_NOT_A_FIELD_VISIT__' + randomUUID() + '.json';
  let indexId = '', movedAndVerified = false, indexVerified = false, trashed = 0, cleanupNeeded = false;
  try {
    const original = await service.readBytes(file);validJpeg(original);
    const destination = await service.folder(parent,PIPE_ROOT,true);
    await mybox('/drive/resources/' + encodeURIComponent(file.resourceId) + '/rename','POST',{name:renamed});
    await mybox('/drive/resources/' + encodeURIComponent(file.resourceId) + '/move','POST',
      {parentId:destination,isOverwrite:false});
    const moved = (await items(destination)).filter(item => item.resourceId === file.resourceId &&
      item.name === renamed && Number(item.size) === original.length);
    if (moved.length !== 1) throw failure('MOVE', 502, '점검 사진의 이동 결과를 확인하지 못했습니다.');
    const reread = await service.readBytes(moved[0]);
    movedAndVerified = digest(reread) === digest(original);
    if (!movedAndVerified) throw failure('MOVE', 502, '이동 후 점검 사진이 달라졌습니다.');
    const indexBytes = Buffer.from(JSON.stringify({testOnly:true,photoHash:digest(original)}));
    await service.uploadBytes(destination,indexName,indexBytes,false);
    const indexes = (await items(destination)).filter(item => item.name === indexName && item.type === 'file');
    if (indexes.length !== 1) throw failure('CATALOG', 502, '점검 목록 파일을 확인하지 못했습니다.');
    indexId = indexes[0].resourceId;
    const index = JSON.parse((await service.readBytes(indexes[0])).toString('utf8'));
    indexVerified = index.testOnly === true && index.photoHash === digest(original);
    if (!indexVerified) throw failure('CATALOG', 502, '점검 목록 내용이 다릅니다.');
  } finally {
    if (!indexId) {
      try { const destination = await service.folder(parent,PIPE_ROOT,false);
        const found = destination ? (await items(destination)).filter(item => item.name === indexName) : [];
        if (found.length === 1) indexId = found[0].resourceId;
      } catch { cleanupNeeded = true; }
    }
    for (const id of [indexId,file.resourceId].filter(Boolean)) {
      try { await mybox('/drive/resources/' + encodeURIComponent(id),'DELETE');trashed++; }
      catch { cleanupNeeded = true; }
    }
  }
  return {passed:movedAndVerified&&indexVerified&&!cleanupNeeded,movedAndVerified,indexVerified,trashed,cleanupNeeded};
}
function uploadUrl(target) {
  if (typeof target.uploadUrl !== 'string' ||
      !/^https:\/\/[a-z0-9.-]+(?::443)?\/v1\/storage\/upload\?/i.test(target.uploadUrl))
    throw failure('UPLOAD_URL', 502, 'MYBOX 업로드 URL 형식을 확인할 수 없습니다.');
  return target.uploadUrl;
}
async function reserveFile(folder, size) {
  const name = PREFIX + randomUUID() + '.jpg';
  const target = await mybox('/drive/files', 'POST',
    {parentId: folder, fileName: name, fileSize: size, isOverwrite: false});
  return {name, uploadUrl: uploadUrl(target)};
}
async function limited(values, limit, work) {
  const results = Array(values.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, values.length)}, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index], index);
    }
  }));
  return results;
}
function batchNames(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
      new Set(value).size !== value.length || !value.every(validName))
    throw failure('INPUT', 400, '점검 파일 목록 형식이 올바르지 않습니다.');
  return value;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ok:false,code:'METHOD'}); }
  if (!process.env.MYBOX_TOKEN || !process.env.MYBOX_DIRECT_PROBE_KEY ||
      process.env.MYBOX_DIRECT_PROBE_KEY.length < 12)
    return res.status(503).json({ok:false,code:'SETUP_REQUIRED',message:'Vercel 서버 환경변수와 재배포 상태를 확인해 주세요.'});
  if (!authorized(req.headers['x-probe-key'], process.env.MYBOX_DIRECT_PROBE_KEY))
    return res.status(403).json({ok:false,code:'INVALID_PROBE_KEY',message:'점검 접근키가 Vercel에 저장된 값과 다릅니다.'});
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (body.action === 'lockCheck')
      return res.status(200).json({ok:true,...await checkFolderLock()});
    if (body.action === 'pipelineCheck' && validName(body.name))
      return res.status(200).json({ok:true,...await checkSavePipeline(body.name)});
    if (body.action === 'reserve' || body.action === 'reserveBatch') {
      const size = Number(body.size);
      if (!Number.isInteger(size) || size < 32 || size > 200000)
        throw failure('SIZE', 400, '점검 사진은 200KB 이하여야 합니다.');
      const count = body.action === 'reserveBatch' ? Number(body.count) : 1;
      if (!Number.isInteger(count) || count < 1 || count > 100)
        throw failure('COUNT', 400, '한 번에 100건까지만 점검할 수 있습니다.');
      const folder = await probeFolder(true);
      if (body.action === 'reserve') return res.status(200).json({ok:true,...await reserveFile(folder,size)});
      const results = await limited(Array.from({length:count}), 4, async () => {
        try { return {ok:true,...await reserveFile(folder,size)}; }
        catch (error) { return {ok:false,code:error.code||'SERVICE',message:error.code?error.message:'URL 발급 실패'}; }
      });
      return res.status(200).json({ok:true,results});
    }
    if (body.action === 'statusBatch' || body.action === 'finishBatch') {
      const names = batchNames(body.names);
      const folder = await probeFolder(false);
      const files = folder ? await items(folder) : [];
      const found = new Map();
      for (const file of files) if (names.includes(file.name)) {
        if (file.type !== 'file' || found.has(file.name))
          throw failure('FILE', 409, '점검 파일 이름이 중복됩니다.');
        found.set(file.name,file);
      }
      if (body.action === 'statusBatch') {
        const size = Number(body.size);
        if (!Number.isInteger(size) || size < 32 || size > 200000)
          throw failure('SIZE', 400, '저장 확인에 필요한 사진 크기가 올바르지 않습니다.');
        return res.status(200).json({ok:true,
          present:names.filter(name=>found.has(name) && Number(found.get(name).size) === size),
          mismatch:names.filter(name=>found.has(name) && Number(found.get(name).size) !== size),
          missing:names.filter(name=>!found.has(name))});
      }
      const results = await limited(names.filter(name=>found.has(name)), 4, async name => {
        try { await mybox('/drive/resources/' + encodeURIComponent(found.get(name).resourceId), 'DELETE');
          return {name,trashed:true}; }
        catch (error) { return {name,trashed:false,code:error.code||'SERVICE'}; }
      });
      return res.status(200).json({ok:true,results,missing:names.filter(name=>!found.has(name))});
    }
    if ((body.action === 'inspect' || body.action === 'finish') && validName(body.name)) {
      const folder = await probeFolder(false);
      const matches = folder ? (await items(folder)).filter(item => item.name === body.name) : [];
      if (matches.length > 1 || matches.length && matches[0].type !== 'file')
        throw failure('FILE', 409, '점검 파일 이름이 중복됩니다.');
      const found = matches.length === 1;
      if (body.action === 'finish' && found)
        await mybox('/drive/resources/' + encodeURIComponent(matches[0].resourceId), 'DELETE');
      return res.status(200).json({ok:true,found,bytes:found ? Number(matches[0].size) : 0,
        movedToTrash:body.action === 'finish' && found});
    }
    throw failure('INPUT', 400, '점검 요청 형식이 올바르지 않습니다.');
  } catch (error) {
    console.warn(JSON.stringify({event:'mybox_direct_probe_failed',code:error.code||'SERVICE',http:error.status||500}));
    return res.status(error.status || 500).json({ok:false,code:error.code||'SERVICE',
      message:error.code ? error.message : '점검 중 연결 오류가 발생했습니다.'});
  }
};
