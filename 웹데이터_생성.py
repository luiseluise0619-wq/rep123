# -*- coding: utf-8 -*-
"""
Vercel 배포용 웹 지도 데이터 생성기  [초보자용 설명]
================================================================================
하는 일: 분류된 주소들을 '시도 → 구군 → 동' 트리로 묶어 web/addresses.js 로 저장.
        이 파일을 index.html(지도 웹앱)이 읽어서 드릴다운 목록과 지도 점을 그린다.

만들어지는 데이터 모양:
    window.ADDR_DATA = { 시도: { 구군: { 동: [ 주소한줄, 주소한줄, ... ] } } }
    주소한줄(배열) = [ 위도, 경도, "주소", 사업장수, 정밀여부 ]
        · 정밀여부 1 = 정확한 좌표 / 0 = 대략 위치(확인필요)
    ※ 전화번호·사업자등록번호는 개인정보라 넣지 않는다(주소·사업장수만).

좌표 출처: geocode_cache.json(지오코딩 결과)에 있으면 그 실좌표를 쓰고,
          없으면 행정구역 근사좌표(동/구 중심점)를 쓴다.
"""

import os
import json
import importlib.util

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
INPUT_XLSX  = os.path.join(BASE_DIR, r'exceldata1.xlsx')
CACHE_PATH  = os.path.join(BASE_DIR, r'geocode_cache.json')
OUT_JS      = os.path.join(BASE_DIR, r'web', r'addresses.js')
# 개인정보 보호를 위해 전화·사업자번호는 결과물에 포함하지 않는다(주소·사업장수만).

# 메인 모듈(한글 파일명) 동적 import → 분류·좌표 로직 재사용
_spec = importlib.util.spec_from_file_location(
    'addr_core', os.path.join(BASE_DIR, r'주소_분류_및_지도생성.py'))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

# 라벨(빈 값 대체)
NO_GUGUN = '(구 없음)'
NO_DONG  = '(동 없음)'
ETC_SIDO = '기타'


def main():
    rows = core.read_rows(INPUT_XLSX)
    records, _ = core.build_records(rows)

    # 실좌표 캐시(있으면). 캐시 키는 '정리주소'이므로 원본주소를 정리해 조회.
    cache = {}
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        print('실좌표 캐시 사용: %d개' % sum(1 for v in cache.values() if v))

    approx_keys = core.load_approx_keys()   # 인근/대표점이라 부정확 → 주황(대략) 표시
    tree = {}
    n_pt = 0
    for r in records:
        sido  = r['시도'] or ETC_SIDO
        gugun = r['구군'] or NO_GUGUN
        dong  = r['동네'] or NO_DONG

        key  = core.clean_address_for_geocoding(r['주소'])
        real = cache.get(key) if cache else None
        if real:                       # 실좌표(캐시)
            good = 0 if key in approx_keys else 1
            lat, lng = round(real[0], 6), round(real[1], 6)
        else:
            loc = core.locate(r['시도'], r['구군'], r['주소'], dong=r['동네'])
            if loc:
                lat, lng = round(loc[0], 6), round(loc[1], 6)
                good = 1 if loc[2] == 'dong' else 0
            else:
                lat, lng, good = None, None, 0

        node = tree.setdefault(sido, {}).setdefault(gugun, {}).setdefault(dong, [])
        node.append([lat, lng, r['주소'], r.get('사업장수', 1), good])
        n_pt += 1

    data_json = json.dumps(tree, ensure_ascii=False, separators=(',', ':'))
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('window.ADDR_DATA = ')
        f.write(data_json)
        f.write(';\n')

    # 요약 출력
    n_sido = len(tree)
    n_gugun = sum(len(g) for g in tree.values())
    n_dong = sum(len(d) for g in tree.values() for d in g.values())
    print('저장:', OUT_JS)
    print('  시도 %d · 구군 %d · 동 %d · 주소 %d건' % (n_sido, n_gugun, n_dong, n_pt))
    print('  파일 크기: %.1f MB' % (os.path.getsize(OUT_JS) / 1024 / 1024))


if __name__ == '__main__':
    main()
