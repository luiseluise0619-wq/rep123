/** Role and ownership checks run on the server on every request, not just in the UI. */
var PHOTO_ADMIN_ID_ = '00000000000000000000000000000000';
function normalizeLogin_(value) {
  value = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(value)) fail_('NAME', '아이디는 영문 소문자·숫자·._- 조합 3~32자로 입력하세요.');
  return value;
}
function ensureAuthKey_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PHOTO_AUTH_KEY_V3')) props.setProperty('PHOTO_AUTH_KEY_V3',
    digest_(Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()));
}
function authMac_(value) {
  var key = secret_('PHOTO_AUTH_KEY_V3');
  if (!key) fail_('AUTH', '관리자 초기 로그인이 필요합니다.');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, key, Utilities.Charset.UTF_8));
}
function employee_(login) {
  if (typeof login !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(login) || login === 'admin') return null;
  var value = PropertiesService.getScriptProperties().getProperty('PHOTO_EMP_' + login);
  if (!value) return null;
  var record = JSON.parse(value);
  if (!/^[0-9a-f]{32}$/.test(record.id) || record.id === PHOTO_ADMIN_ID_ || record.login !== login) fail_('ACCOUNTS', '직원 계정 확인이 필요합니다.');
  return record;
}
function actorForLogin_(login) {
  if (login === 'admin') return {id: PHOTO_ADMIN_ID_, login: 'admin', role: 'admin', name: '관리자',
    version: authMac_('admin-credential-v3\n' + secret_('PHOTO_ADMIN_PASSWORD'))};
  var account = employee_(login);
  return account && account.enabled === true ? {id: account.id, login: account.login, role: 'staff',
    name: account.name, version: account.version} : null;
}
function authenticateActor_(login, password) {
  password = String(password || '');
  if (!password || password.length > 200) return null;
  if (login === 'admin') {
    if (!equal_(digest_(password), digest_(secret_('PHOTO_ADMIN_PASSWORD')))) return null;
    ensureAuthKey_(); return actorForLogin_('admin');
  }
  var account = employee_(login);
  if (!account || !account.enabled || !secret_('PHOTO_AUTH_KEY_V3')) return null;
  if (!equal_(account.codeHash, authMac_('employee-code-v3\n' + account.salt + '\n' + password))) return null;
  return actorForLogin_(login);
}
function requireAdmin_(token) {
  var user = verifySession_(token);
  if (user.role !== 'admin') fail_('FORBIDDEN', '관리자만 사용할 수 있습니다.');
  return user;
}
function photoOwner_(file) {
  var owner = String(file.name || '').split('__')[4];
  // A legacy display name was at most 24 characters, so it cannot impersonate this 36-character marker.
  return /^v3u-[0-9a-f]{32}$/.test(owner) ? owner.slice(4) : null;
}
function canSeePhoto_(user, file) { return user.role === 'admin' || photoOwner_(file) === user.id; }
function accountPublic_(record) {
  return {id: record.id, login: record.login, name: record.name, enabled: record.enabled, createdAt: record.createdAt};
}
function employeeRecords_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(props).filter(function(key) { return key.indexOf('PHOTO_EMP_') === 0; })
    .map(function(key) { return JSON.parse(props[key]); }).sort(function(a,b) { return a.login.localeCompare(b.login); });
}
function listEmployees(session) {
  return rpc_(function() { requireAdmin_(session); return {employees: employeeRecords_().map(accountPublic_)}; });
}
function manageEmployee(session, action, input) {
  return rpc_(function() {
    requireAdmin_(session);
    input = input || {};
    var login = normalizeLogin_(input.login), props = PropertiesService.getScriptProperties();
    if (login === 'admin') fail_('ACCOUNT', '관리자 계정은 직원 계정으로 만들 수 없습니다.');
    var record = employee_(login), code = null;
    if (action === 'create') {
      if (record) fail_('ACCOUNT', '이미 사용 중인 아이디입니다.');
      if (employeeRecords_().length >= 100) fail_('ACCOUNT', '무료 운영 안전 한도인 직원 계정 100개에 도달했습니다.');
      var name = String(input.name || '').trim();
      if (!/^[\p{L}\p{N} ._-]{1,24}$/u.test(name)) fail_('NAME', '담당자 이름은 한글·영문·숫자 등 24자 이내로 입력하세요.');
      record = {id: Utilities.getUuid().replace(/-/g,''), login: login, name: name, enabled: true, createdAt: new Date().toISOString()};
    } else {
      if (!record || input.id !== record.id) fail_('ACCOUNT', '직원 계정을 새로고침한 후 다시 선택하세요.');
      if (['reset','disable','enable'].indexOf(action) < 0) fail_('ACCOUNT', '지원하지 않는 계정 작업입니다.');
      record.enabled = action !== 'disable';
    }
    record.version = Utilities.getUuid();
    if (action === 'create' || action === 'reset') {
      // High-entropy, individually issued bearer code; not a guessable human password.
      code = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
        Utilities.getUuid() + Utilities.getUuid(), Utilities.Charset.UTF_8)).slice(0,16);
      record.salt = Utilities.getUuid();
      record.codeHash = authMac_('employee-code-v3\n' + record.salt + '\n' + code);
    }
    props.setProperty('PHOTO_EMP_' + login, JSON.stringify(record));
    return {employee: accountPublic_(record), employeeLink: code ? PHOTO_LIMITS_.webAppUrl + '#staff=' + encodeURIComponent(login) + '&key=' + encodeURIComponent(code) : null};
  });
}
