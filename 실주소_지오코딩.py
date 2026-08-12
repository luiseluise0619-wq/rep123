# -*- coding: utf-8 -*-
"""
무료 지오코딩으로 '실제 위·경도'를 붙여 모바일 지도(모바일_구글지도.html)를 다시 생성
================================================================================

- 백엔드 교체형: VWORLD(국토부) · KAKAO · NOMINATIM 중 설정값 한 줄로 선택
- 캐시(geocode_cache.json)로 '중단 후 재시작' 지원 (이미 성공한 주소는 재호출 안 함)
- 초당 호출 제한 + 실패 재시도(백오프)
- 지오코딩 실패/미매칭 주소는 기존 '행정구역 근사좌표'로 자동 폴백
- 표준 라이브러리(urllib)만 사용 → 별도 설치 불필요

준비물
    · KAKAO  : https://developers.kakao.com  → 앱 생성 → REST API 키
               (기존 앱과 별개로 새 앱을 만들면 키·쿼터가 완전히 분리됩니다)
    · VWORLD : https://www.vworld.kr  → 인증키 발급(지오코더 API)
    · NOMINATIM : 키 불필요(단, 초당 1건·대량 사용 제한 → 소량 테스트용)

사용법
    1) 아래 CONFIG 에서 BACKEND 와 해당 API 키를 채운다.  (경로는 r'' raw string)
    2) python 실주소_지오코딩.py
    3) geocode_cache.json 이 채워지고, 모바일_구글지도.html 이 실제 좌표로 갱신된다.
       (중간에 끊겨도 다시 실행하면 캐시부터 이어서 진행)
"""

import os
import json
import time
import importlib.util
import urllib.parse
import urllib.request
import urllib.error
import http.client
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed

# =============================================================================
# CONFIG
# =============================================================================
# 백엔드는 아래에서 '키 파일'을 보고 자동 선택됩니다(편집 불필요):
#   kakao_key.txt 에 키가 있으면 → KAKAO,  없고 vworld_key.txt 에 있으면 → VWORLD
KAKAO_REST_KEY = r''
VWORLD_KEY     = r''
NOMINATIM_UA   = r'addr-map-geocoder/1.0 (contact: your_email@example.com)'

MAX_RETRY = 3               # 네트워크 오류 시 재시도 횟수
CACHE_EVERY = 500           # 이 건수마다 캐시 파일 저장(중단 대비)
RETRY_FAILED = True         # 실패(null)한 주소도 다시 시도 (여러 번 돌리면 점점 채워짐)
TEST_LIMIT = 0              # 0 이면 전체, N>0 이면 앞에서 N건만(키 확인용)

# =============================================================================
# 경로 (윈도우 역슬래시 방지 r'')
# =============================================================================
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
INPUT_XLSX  = os.path.join(BASE_DIR, r'exceldata1.xlsx')
CACHE_PATH  = os.path.join(BASE_DIR, r'geocode_cache.json')
OUTPUT_HTML = os.path.join(BASE_DIR, r'모바일_구글지도.html')


def _read_key(fname):
    p = os.path.join(BASE_DIR, fname)
    if os.path.exists(p):
        with open(p, 'r', encoding='utf-8') as f:
            v = f.read().strip()
        if v and not v.startswith('여기에'):
            return v
    return ''


# 키 파일에 붙여넣기만 하면 됨(.py 편집 불필요). 카카오가 있으면 카카오 우선.
if not KAKAO_REST_KEY:
    KAKAO_REST_KEY = _read_key('kakao_key.txt')
if not VWORLD_KEY:
    VWORLD_KEY = _read_key('vworld_key.txt')

if KAKAO_REST_KEY:
    BACKEND = 'KAKAO'
elif VWORLD_KEY:
    BACKEND = 'VWORLD'
else:
    BACKEND = 'VWORLD'      # 키 없으면 안내 후 종료

# 동시 처리 개수(병렬). 카카오는 잘 안 끊겨 8, VWorld는 3(과하면 서버가 끊음).
WORKERS = {'VWORLD': 3, 'KAKAO': 8, 'NOMINATIM': 1}[BACKEND]

# 같은 폴더의 메인 모듈(한글 파일명)을 동적 import 하여 분류·지도 로직 재사용
_spec = importlib.util.spec_from_file_location(
    'addr_core', os.path.join(BASE_DIR, r'주소_분류_및_지도생성.py'))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)


# =============================================================================
# HTTP 유틸
# =============================================================================
def _http_get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=6) as resp:   # 굼뜬 응답은 빨리 포기
        return json.loads(resp.read().decode('utf-8'))


# =============================================================================
# 백엔드별 지오코더 : 주소 → (위도, 경도) 또는 None
#   세 백엔드 모두 WGS84(EPSG:4326)로 좌표를 받으므로 좌표계 변환이 필요 없음
# =============================================================================
def geocode_kakao(addr):
    hdr = {'Authorization': 'KakaoAK ' + KAKAO_REST_KEY}
    # 1) 주소 검색 (정확)
    url = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + \
          urllib.parse.quote(addr)
    docs = (_http_get_json(url, hdr).get('documents') or [])
    if docs:
        d = docs[0]
        return float(d['y']), float(d['x'])      # y=위도, x=경도
    # 2) 키워드 검색 폴백 (주소 검색 실패 시)
    url2 = 'https://dapi.kakao.com/v2/local/search/keyword.json?query=' + \
           urllib.parse.quote(addr)
    docs2 = (_http_get_json(url2, hdr).get('documents') or [])
    if docs2:
        d = docs2[0]
        return float(d['y']), float(d['x'])
    return None


def _vworld_once(addr, addr_type):
    url = ('https://api.vworld.kr/req/address?service=address&request=getcoord'
           '&version=2.0&crs=epsg:4326&format=json&type=' + addr_type +
           '&key=' + VWORLD_KEY + '&address=' + urllib.parse.quote(addr))
    data = _http_get_json(url)
    resp = data.get('response', {})
    if resp.get('status') != 'OK':
        return None
    pt = resp['result']['point']
    return float(pt['y']), float(pt['x'])        # y=위도, x=경도


def geocode_vworld(addr):
    # 도로명(ROAD) 우선, 실패 시 지번(PARCEL) 재시도
    for t in ('ROAD', 'PARCEL'):
        try:
            r = _vworld_once(addr, t)
            if r:
                return r
        except urllib.error.HTTPError:
            pass
    return None


def geocode_nominatim(addr):
    time.sleep(1.0)   # Nominatim 정책: 초당 1건
    url = ('https://nominatim.openstreetmap.org/search?format=json&limit=1'
           '&countrycodes=kr&q=' + urllib.parse.quote(addr))
    data = _http_get_json(url, {'User-Agent': NOMINATIM_UA})
    if not data:
        return None
    return float(data[0]['lat']), float(data[0]['lon'])


GEOCODERS = {'KAKAO': geocode_kakao, 'VWORLD': geocode_vworld, 'NOMINATIM': geocode_nominatim}


# 일시적 네트워크 오류(연결 끊김·타임아웃 등)는 모두 재시도 대상
NET_ERRORS = (
    urllib.error.URLError,          # DNS/연결 실패 등
    http.client.HTTPException,      # RemoteDisconnected, BadStatusLine, IncompleteRead 등
    OSError,                        # ConnectionResetError 등 소켓 계열
    socket.timeout, TimeoutError,
    ValueError, KeyError,
)


# 시도할 지오코더 순서: 주 백엔드 먼저, 실패하면 다른 키가 있는 백엔드로 폴백
#   (예: 카카오가 못 찾는 주소를 VWorld가 찾기도 함)
def _geocoder_chain():
    chain = []
    if BACKEND == 'KAKAO':
        if KAKAO_REST_KEY: chain.append(geocode_kakao)
        if VWORLD_KEY:     chain.append(geocode_vworld)   # 카카오 실패분 → VWorld
    elif BACKEND == 'VWORLD':
        if VWORLD_KEY:     chain.append(geocode_vworld)
        if KAKAO_REST_KEY: chain.append(geocode_kakao)
    else:
        chain.append(GEOCODERS[BACKEND])
    return chain or [GEOCODERS[BACKEND]]


CHAIN = None   # main()에서 초기화


def geocode_one(addr):
    for fn in CHAIN:
        for attempt in range(1, MAX_RETRY + 1):
            try:
                r = fn(addr)
                if r:
                    return r
                break                 # 못 찾음(정상 응답) → 다음 엔진으로
            except NET_ERRORS:
                if attempt == MAX_RETRY:
                    break             # 이 엔진 포기 → 다음 엔진으로
                time.sleep(0.4 * attempt)   # 0.4s, 0.8s, 1.2s (짧게)
    return None


# =============================================================================
# 캐시
# =============================================================================
def load_cache():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_PATH, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)


# =============================================================================
# 메인
# =============================================================================
def main():
    if not KAKAO_REST_KEY and not VWORLD_KEY:
        raise SystemExit(
            '키가 없습니다. 둘 중 하나에 키를 붙여넣고 저장하세요:\n'
            '  · kakao_key.txt  (카카오 REST API 키 · 권장)\n'
            '  · vworld_key.txt (VWorld 인증키)')

    global CHAIN
    CHAIN = _geocoder_chain()
    names = ' → '.join(fn.__name__.replace('geocode_', '').upper() for fn in CHAIN)
    print('== 지오코딩 엔진:', names, '(앞이 실패하면 뒤로 폴백) ==')
    rows = core.read_rows(INPUT_XLSX)
    records, _ = core.build_records(rows)

    # 상세주소를 뗀 '깔끔한 주소'로 중복 제거 → 호출 수 최소화 (캐시 키도 이것)
    clean = core.clean_address_for_geocoding
    unique = []
    seen = set()
    for r in records:
        c = clean(r['주소'])
        if c and c not in seen:
            seen.add(c)
            unique.append(c)
    print('전체 %d행 → 고유 정리주소 %d개' % (len(records), len(unique)))

    cache = load_cache()                          # {정리주소: [lat,lng] | null}
    todo = [c for c in unique
            if c not in cache or (RETRY_FAILED and cache.get(c) is None)]

    test_mode = TEST_LIMIT and TEST_LIMIT > 0
    if test_mode:
        todo = todo[:TEST_LIMIT]
        print('★ 테스트 모드: 앞 %d건만 시도 (정상 확인되면 TEST_LIMIT=0 으로 바꿔 전체 실행)' % len(todo))
    else:
        print('이번에 지오코딩할 주소: %d개 (캐시 %d개 재사용)' % (len(todo), len(unique) - len(todo)))

    done = 0
    ok = 0
    workers = 1 if test_mode else WORKERS
    print('동시 처리 %d개로 진행합니다.' % workers)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(geocode_one, c): c for c in todo}
        for fut in as_completed(futures):
            c = futures[fut]
            try:
                res = fut.result()
            except Exception:
                res = None
            cache[c] = [res[0], res[1]] if res else None
            if res:
                ok += 1
                if test_mode:
                    print('  ✓ %-40s → 위도 %.6f, 경도 %.6f' % (c[:40], res[0], res[1]))
            elif test_mode:
                print('  ✗ %-40s → 실패(매칭 없음)' % c[:40])
            done += 1
            if not test_mode and done % CACHE_EVERY == 0:
                save_cache(cache)
                print('  ... %d/%d 진행 (성공 %d)' % (done, len(todo), ok))
    save_cache(cache)
    print('지오코딩 완료: 신규 성공 %d / 시도 %d' % (ok, len(todo)))

    if test_mode:
        print('\n★ 테스트 끝. 성공률이 괜찮으면 파일 상단 TEST_LIMIT = 0 으로 바꾸고 다시 실행하세요.')
        print('  (지도 재생성은 전체 실행 때 자동으로 됩니다.)')
        return

    # 원본주소 → 실좌표 매핑 (정리주소 경유)
    coord_lookup = {}
    for r in records:
        v = cache.get(clean(r['주소']))
        if v:
            coord_lookup[r['주소']] = tuple(v)
    print('실좌표 확보 주소: %d개' % len(coord_lookup))

    # 실제 좌표로 모바일 지도 재생성 (미확보 주소는 근사좌표 폴백)
    core.save_map_html(records, OUTPUT_HTML, coord_lookup=coord_lookup)
    print('\n[완료] 모바일 지도 갱신:', OUTPUT_HTML)

    # 웹(구·동 드릴다운) 데이터도 자동 갱신 → 명령 하나로 끝
    try:
        wspec = importlib.util.spec_from_file_location(
            'webgen', os.path.join(BASE_DIR, r'웹데이터_생성.py'))
        webgen = importlib.util.module_from_spec(wspec)
        wspec.loader.exec_module(webgen)
        webgen.main()
        print('[완료] 웹 데이터 갱신: web/addresses.js')
    except Exception as e:
        print('웹 데이터 갱신은 건너뜀(%s) — 필요하면 python 웹데이터_생성.py 실행' % e)

    # 성공률 요약
    total = len(records)
    real = len(coord_lookup)
    print('\n★ 실좌표 %d / 전체 %d  (%.1f%%),  근사 폴백 %d건'
          % (real, total, real / total * 100 if total else 0, total - real))
    print('  자세한 검증:  python 지오코딩_검증.py')


if __name__ == '__main__':
    main()
