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

# ★ 보안: 웹(Vercel)은 URL만 알면 누구나 접속 가능(공개)이므로,
#   기본적으로 전화·사업자번호(개인정보)를 웹 데이터에 넣지 않는다.
#   Vercel 배포에 인증(비밀번호)을 걸었거나, 내부용으로만 쓴다면 True 로.
WEB_INCLUDE_CONTACT = False

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

    tree = {}
    n_pt = 0
    for r in records:
        sido  = r['시도'] or ETC_SIDO
        gugun = r['구군'] or NO_GUGUN
        dong  = r['동네'] or NO_DONG

        real = cache.get(core.clean_address_for_geocoding(r['주소'])) if cache else None
        loc = real or core.locate(r['시도'], r['구군'], r['주소'])
        lat, lng = (round(loc[0], 6), round(loc[1], 6)) if loc else (None, None)

        tel = r['전화'] if WEB_INCLUDE_CONTACT else ''
        biz = r['사업자'] if WEB_INCLUDE_CONTACT else ''
        node = tree.setdefault(sido, {}).setdefault(gugun, {}).setdefault(dong, [])
        node.append([lat, lng, r['주소'], tel, biz, r.get('사업장수', 1)])
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
