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

# =============================================================================
# CONFIG  (여기만 수정)
# =============================================================================
BACKEND = 'VWORLD'          # 'VWORLD' | 'KAKAO' | 'NOMINATIM'

KAKAO_REST_KEY = r''        # 예) r'abcd1234...'   (BACKEND='KAKAO' 일 때)
VWORLD_KEY     = r''        # 예) r'XXXX-XXXX-...' (BACKEND='VWORLD' 일 때)
NOMINATIM_UA   = r'addr-map-geocoder/1.0 (contact: your_email@example.com)'

# 호출 간격(초). 서버 정책·쿼터에 맞춰 조절.
SLEEP_SEC = {'VWORLD': 0.10, 'KAKAO': 0.05, 'NOMINATIM': 1.05}[BACKEND]
MAX_RETRY = 3               # 네트워크 오류 시 재시도 횟수
CACHE_EVERY = 200           # 이 건수마다 캐시 파일 저장(중단 대비)
RETRY_FAILED = False        # True 면 이전에 실패(null)한 주소도 다시 시도

# =============================================================================
# 경로 (윈도우 역슬래시 방지 r'')
# =============================================================================
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
INPUT_XLSX  = os.path.join(BASE_DIR, r'exceldata1.xlsx')
CACHE_PATH  = os.path.join(BASE_DIR, r'geocode_cache.json')
OUTPUT_HTML = os.path.join(BASE_DIR, r'모바일_구글지도.html')

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
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


# =============================================================================
# 백엔드별 지오코더 : 주소 → (위도, 경도) 또는 None
#   세 백엔드 모두 WGS84(EPSG:4326)로 좌표를 받으므로 좌표계 변환이 필요 없음
# =============================================================================
def geocode_kakao(addr):
    url = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + \
          urllib.parse.quote(addr)
    data = _http_get_json(url, {'Authorization': 'KakaoAK ' + KAKAO_REST_KEY})
    docs = data.get('documents') or []
    if not docs:
        return None
    d = docs[0]
    return float(d['y']), float(d['x'])          # y=위도, x=경도


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
    url = ('https://nominatim.openstreetmap.org/search?format=json&limit=1'
           '&countrycodes=kr&q=' + urllib.parse.quote(addr))
    data = _http_get_json(url, {'User-Agent': NOMINATIM_UA})
    if not data:
        return None
    return float(data[0]['lat']), float(data[0]['lon'])


GEOCODERS = {'KAKAO': geocode_kakao, 'VWORLD': geocode_vworld, 'NOMINATIM': geocode_nominatim}


def geocode_one(addr):
    fn = GEOCODERS[BACKEND]
    for attempt in range(1, MAX_RETRY + 1):
        try:
            return fn(addr)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
            if attempt == MAX_RETRY:
                print('    ! 실패(%s): %s' % (type(e).__name__, addr[:30]))
                return None
            time.sleep(2 ** attempt)             # 2s, 4s, 8s 백오프
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
    if BACKEND == 'KAKAO' and not KAKAO_REST_KEY:
        raise SystemExit('KAKAO_REST_KEY 를 입력하세요.')
    if BACKEND == 'VWORLD' and not VWORLD_KEY:
        raise SystemExit('VWORLD_KEY 를 입력하세요.')

    print('== 지오코딩 백엔드:', BACKEND, '==')
    rows = core.read_rows(INPUT_XLSX)
    records, _ = core.build_records(rows)

    # 중복 제거된 고유 주소만 호출 (호출 수 절감)
    unique = []
    seen = set()
    for r in records:
        a = r['주소']
        if a not in seen:
            seen.add(a)
            unique.append(a)
    print('고유 주소 %d개 (전체 %d행)' % (len(unique), len(records)))

    cache = load_cache()
    todo = [a for a in unique
            if a not in cache or (RETRY_FAILED and cache.get(a) is None)]
    print('이번에 지오코딩할 주소: %d개 (캐시 %d개 재사용)' % (len(todo), len(unique) - len(todo)))

    done = 0
    ok = 0
    for a in todo:
        res = geocode_one(a)
        cache[a] = [res[0], res[1]] if res else None
        if res:
            ok += 1
        done += 1
        if done % CACHE_EVERY == 0:
            save_cache(cache)
            print('  ... %d/%d 진행 (성공 %d)' % (done, len(todo), ok))
        time.sleep(SLEEP_SEC)
    save_cache(cache)
    print('지오코딩 완료: 신규 성공 %d / 시도 %d' % (ok, len(todo)))

    # 실제 좌표 lookup 구성 (튜플)
    coord_lookup = {a: tuple(v) for a, v in cache.items() if v}
    print('실좌표 확보 주소: %d개' % len(coord_lookup))

    # 실제 좌표로 지도 재생성 (미확보 주소는 근사좌표 폴백)
    core.save_map_html(records, OUTPUT_HTML, coord_lookup=coord_lookup)
    print('\n[완료] 지도 갱신:', OUTPUT_HTML)


if __name__ == '__main__':
    main()
