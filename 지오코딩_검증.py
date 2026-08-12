# -*- coding: utf-8 -*-
"""
실좌표(지오코딩) 결과 검증 리포트
================================================================================
지오코딩(실주소_지오코딩.py) 실행 후, 얼마나 실좌표로 바뀌었는지 한눈에 확인한다.

  python 지오코딩_검증.py

출력:
  · 전체 성공률 (실좌표 / 근사)
  · 시도별 성공률
  · 실패(근사로 남은) 주소 예시 + 전체 목록을 '지오코딩_실패목록.txt' 로 저장
"""
import os
import json
import importlib.util
from collections import defaultdict

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
INPUT_XLSX = os.path.join(BASE_DIR, r'exceldata1.xlsx')
CACHE_PATH = os.path.join(BASE_DIR, r'geocode_cache.json')
FAIL_TXT   = os.path.join(BASE_DIR, r'지오코딩_실패목록.txt')

_spec = importlib.util.spec_from_file_location(
    'addr_core', os.path.join(BASE_DIR, r'주소_분류_및_지도생성.py'))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)


def bar(pct, width=24):
    n = int(round(pct / 100 * width))
    return '█' * n + '░' * (width - n)


def main():
    if not os.path.exists(CACHE_PATH):
        print('아직 geocode_cache.json 이 없습니다. 먼저  python 실주소_지오코딩.py  를 실행하세요.')
        return

    with open(CACHE_PATH, 'r', encoding='utf-8') as f:
        cache = json.load(f)
    clean = core.clean_address_for_geocoding

    rows = core.read_rows(INPUT_XLSX)
    records, _ = core.build_records(rows)

    total = len(records)
    real = 0
    per_sido = defaultdict(lambda: [0, 0])   # 시도 -> [실좌표, 전체]
    fails = []
    for r in records:
        s = r['시도'] or '기타'
        per_sido[s][1] += 1
        if cache.get(clean(r['주소'])):
            real += 1
            per_sido[s][0] += 1
        else:
            fails.append(r['주소'])

    approx = total - real
    print('=' * 52)
    print(' 실좌표 검증 리포트')
    print('=' * 52)
    print(' 전체 주소   : %6d 건' % total)
    print(' 실좌표 성공 : %6d 건  (%.1f%%)  %s' % (real, real / total * 100, bar(real / total * 100)))
    print(' 근사 폴백   : %6d 건  (%.1f%%)' % (approx, approx / total * 100))
    print('-' * 52)
    print(' [시도별 성공률]')
    for s in sorted(per_sido, key=lambda k: -per_sido[k][1]):
        ok, tot = per_sido[s]
        print('   %-10s %5d/%-5d  %5.1f%%  %s' % (s, ok, tot, ok / tot * 100, bar(ok / tot * 100, 16)))

    if fails:
        # 중복 제거해 실패 목록 저장
        uniq_fail = sorted(set(fails))
        with open(FAIL_TXT, 'w', encoding='utf-8') as f:
            f.write('\n'.join(uniq_fail))
        print('-' * 52)
        print(' 실패(근사로 남음) 예시 5개:')
        for a in uniq_fail[:5]:
            print('   ·', a)
        print(' → 전체 실패목록 %d건 저장: %s' % (len(uniq_fail), FAIL_TXT))
    print('=' * 52)
    print(' 지도에서 눈으로 확인: 파란점=실좌표, 주황점=근사')
    print(' (모바일_구글지도.html 좌하단 범례에 개수 표시)')


if __name__ == '__main__':
    main()
