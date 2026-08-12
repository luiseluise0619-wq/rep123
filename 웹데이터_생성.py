# -*- coding: utf-8 -*-
"""
Vercel 배포용 웹 지도 데이터 생성기
================================================================================
분류된 주소를 '시도 → 구군 → 동' 트리로 묶어 web/addresses.js 로 저장한다.
(index.html 의 드릴다운 UI + 구글맵 마커가 이 데이터를 사용)

각 주소 레코드 형식(배열): [위도, 경도, "주소", "전화번호", "사업자등록번호"]
좌표는 geocode_cache.json(실주소_지오코딩.py 결과)이 있으면 실좌표,
없으면 행정구역 근사좌표를 사용한다.
"""

import os
import json
import importlib.util

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
INPUT_XLSX  = os.path.join(BASE_DIR, r'exceldata1.xlsx')
CACHE_PATH  = os.path.join(BASE_DIR, r'geocode_cache.json')
OUT_JS      = os.path.join(BASE_DIR, r'web', r'addresses.js')

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

    # 실좌표 캐시(있으면)
    coord_lookup = {}
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        coord_lookup = {a: tuple(v) for a, v in cache.items() if v}
        print('실좌표 캐시 사용: %d개' % len(coord_lookup))

    tree = {}
    n_pt = 0
    for r in records:
        sido  = r['시도'] or ETC_SIDO
        gugun = r['구군'] or NO_GUGUN
        dong  = r['동네'] or NO_DONG

        loc = coord_lookup.get(r['주소']) or core.locate(r['시도'], r['구군'], r['주소'])
        lat, lng = (round(loc[0], 6), round(loc[1], 6)) if loc else (None, None)

        node = tree.setdefault(sido, {}).setdefault(gugun, {}).setdefault(dong, [])
        node.append([lat, lng, r['주소'], r['전화'], r['사업자']])
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
