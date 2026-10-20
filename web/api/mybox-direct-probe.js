// Isolated browser-to-MYBOX feasibility test. Never used for field visits.
// MYBOX_TOKEN and MYBOX_DIRECT_PROBE_KEY are Vercel server environment variables.
const {randomUUID, timingSafeEqual} = require('node:crypto');

const ROOT = '연결점검_현장방문아님';
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
  try { return await response.json(); }
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
      if (body.action === 'statusBatch')
        return res.status(200).json({ok:true,present:names.filter(name=>found.has(name)),missing:names.filter(name=>!found.has(name))});
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
