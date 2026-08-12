# -*- coding: utf-8 -*-
"""
gimi9(geocoder-kr) 결과를 카카오 지오코딩 결과(geocode_cache.json)에 합치기
================================================================================
카카오가 못 찾은 주소를 gimi9에서 받아온 좌표로 채운다.

■ 준비: gimi9 결과 표(주소 포함)를 같은 폴더에 저장
   - 파일명: gimi9결과.txt  (또는 .csv / .tsv / .xlsx)
   - 반드시 '주소(inputaddr)' 컬럼이 있어야 함 (gimi9 화면 표를 복사해 저장하면 됨)
   - 컬럼: 상태 / inputaddr / x_axis(경도) / y_axis(위도)  (한글 헤더도 자동 인식)

■ 실행:  python gimi9_병합.py   (또는 gimi9병합_실행.bat 더블클릭)
   → geocode_cache.json 갱신 + 모바일/웹 지도 재생성
   → '확인필요_목록.html' 생성 (대표주소 등 위치가 대충 찍힌 것만 모아 검토용)
"""
import os
import re
import csv
import json
import glob
import html
import importlib.util

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(BASE_DIR, r'geocode_cache.json')
OUT_HTML   = os.path.join(BASE_DIR, r'확인필요_목록.html')
OUTPUT_MAP = os.path.join(BASE_DIR, r'모바일_구글지도.html')

core_spec = importlib.util.spec_from_file_location(
    'core', os.path.join(BASE_DIR, r'주소_분류_및_지도생성.py'))
core = importlib.util.module_from_spec(core_spec)
core_spec.loader.exec_module(core)
clean = core.clean_address_for_geocoding

# 상태 → 신뢰도 등급
PRECISE = ('도로명 주소', '지번 주소')                 # 정확
NEARBY  = ('인근 지번 주소', '인근 도로명 주소')        # 근처(대체로 OK)
# 그 외(법정동/행정동/시군구/리 대표주소) = 대충 → '확인필요'


def _find_file():
    for pat in ('gimi9결과.*', 'GIMI9*.*', 'gimi9*.*'):
        for f in glob.glob(os.path.join(BASE_DIR, pat)):
            if f.lower().endswith(('.txt', '.csv', '.tsv', '.xlsx')):
                return f
    return None


def _read_rows(path):
    """[(상태, 주소, 경도, 위도), ...] 로 읽기. 헤더 자동 인식."""
    if path.lower().endswith('.xlsx'):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        table = [[c for c in row] for row in wb.active.iter_rows(values_only=True)]
    else:
        with open(path, 'r', encoding='utf-8-sig') as f:
            sample = f.read()
        delim = '\t' if sample.count('\t') > sample.count(',') else ','
        table = list(csv.reader(sample.splitlines(), delimiter=delim))

    if not table:
        return []
    header = [str(h or '').strip().lower() for h in table[0]]

    def find(*names):
        for i, h in enumerate(header):
            if any(n in h for n in names):
                return i
        return -1

    ci_st = find('상태', 'success', '성공여부')
    ci_ad = find('inputaddr', '주소', '입력주소')
    ci_x  = find('x_axis', 'x좌표', '경도')
    ci_y  = find('y_axis', 'y좌표', '위도')
    if ci_ad < 0 or ci_x < 0 or ci_y < 0:
        raise SystemExit(
            '파일에 주소/좌표 컬럼을 못 찾았습니다. gimi9 화면의 표(주소 포함)를\n'
            '  gimi9결과.txt 로 저장했는지 확인하세요. (헤더: 상태, inputaddr, x_axis, y_axis)')

    out = []
    for row in table[1:]:
        if len(row) <= max(ci_ad, ci_x, ci_y):
            continue
        addr = str(row[ci_ad] or '').strip()
        try:
            x = float(row[ci_x]); y = float(row[ci_y])
        except (TypeError, ValueError):
            continue
        st = str(row[ci_st] or '').strip() if ci_st >= 0 else ''
        st = st.split(':')[0].strip()        # "인근 지번 주소: 262-4" → "인근 지번 주소"
        if addr and 33.0 < y < 39.5 and 124.0 < x < 132.0:   # 한국 좌표 범위 검증
            out.append((st, addr, x, y))
    return out


def main():
    path = _find_file()
    if not path:
        raise SystemExit(
            'gimi9 결과 파일이 없습니다.\n'
            '  gimi9 화면의 표(주소 포함)를 메모장에 붙여넣고 gimi9결과.txt 로 저장하세요.')
    print('[1/3] gimi9 결과 읽기 :', os.path.basename(path))
    rows = _read_rows(path)
    print('      → %d행' % len(rows))

    cache = {}
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH, 'r', encoding='utf-8') as f:
                cache = json.loads(f.read() or '{}')
        except ValueError:
            print('      ⚠ 기존 캐시가 손상됨 → 새로 만듭니다.')

    n_precise = n_nearby = n_rep = 0
    need_check = []       # 정확(도로명/지번) 빼고 전부: 근처 + 대표
    for st, addr, x, y in rows:
        key = clean(addr)
        cache[key] = [round(y, 6), round(x, 6)]    # [위도, 경도]
        if st in PRECISE:
            n_precise += 1
        elif st in NEARBY:
            n_nearby += 1
            need_check.append((addr, st, y, x, 'nearby'))
        else:
            n_rep += 1
            need_check.append((addr, st, y, x, 'rep'))

    # 백업 후 저장(원자적)
    tmp = CACHE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, CACHE_PATH)
    print('[2/3] 캐시 병합: 정확 %d · 근처 %d · 대표(확인요) %d' % (n_precise, n_nearby, n_rep))

    # 지도 재생성
    coord_lookup = {}
    rows_in = core.read_rows(os.path.join(BASE_DIR, r'exceldata1.xlsx'))
    recs, _ = core.build_records(rows_in)
    for r in recs:
        v = cache.get(clean(r['주소']))
        if v:
            coord_lookup[r['주소']] = tuple(v)
    core.save_map_html(recs, OUTPUT_MAP, coord_lookup=coord_lookup)
    try:
        wspec = importlib.util.spec_from_file_location(
            'webgen', os.path.join(BASE_DIR, r'웹데이터_생성.py'))
        webgen = importlib.util.module_from_spec(wspec)
        wspec.loader.exec_module(webgen)
        webgen.main()
    except Exception as e:
        print('      웹 데이터 갱신 생략(%s)' % e)

    _write_check_html(need_check)
    print('[3/3] 확인필요 목록:', OUT_HTML, '(%d건)' % len(need_check))
    print('\n[완료] 실좌표 병합 + 지도 갱신 끝.')


def _write_check_html(items):
    # 대표(가장 부정확) 먼저, 그다음 근처. 같은 등급 안에선 주소순.
    order = {'rep': 0, 'nearby': 1}
    items = sorted(items, key=lambda t: (order.get(t[4], 9), t[0]))
    rows_html = []
    for addr, st, lat, lng, cat in items:
        q = html.escape(addr, quote=True).replace(' ', '%20')
        tag = ('<span class="tag rep">대충(대표)</span>' if cat == 'rep'
               else '<span class="tag near">근처(인근)</span>')
        rows_html.append(
            '<tr class="%s"><td>%s</td><td>%s<br><span class="st">%s</span></td>'
            '<td class="mono">%.5f, %.5f</td>'
            '<td><a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=%s">🔍 지도확인</a></td></tr>'
            % (cat, html.escape(addr), tag, html.escape(st), lat, lng, q))
    doc = ("""<title>확인 필요한 주소</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root{--bg:#f6f7f5;--card:#fff;--ink:#1b2530;--mut:#5c6b7a;--line:#dde3e0;--acc:#c9781a;--acc2:#1a73e8}
 @media(prefers-color-scheme:dark){:root{--bg:#0f141a;--card:#161d26;--ink:#e6ecf2;--mut:#93a2b3;--line:#28323d;--acc:#e2a24a;--acc2:#5b9bf3}}
 body{margin:0;background:var(--bg);color:var(--ink);font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;line-height:1.6}
 .wrap{max-width:900px;margin:0 auto;padding:24px 18px 80px}
 h1{font-size:1.5rem;margin:8px 0}
 .lead{color:var(--mut);margin:0 0 18px}
 .badge{display:inline-block;background:var(--acc);color:#fff;border-radius:999px;padding:2px 11px;font-size:.85rem;font-weight:bold}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
 th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:.92rem;vertical-align:top}
 th{color:var(--mut);font-size:.78rem;letter-spacing:.03em}
 tr:last-child td{border-bottom:0}
 .st{color:var(--mut);font-size:.78rem}
 .mono{font-family:Consolas,monospace;color:var(--mut);white-space:nowrap}
 a{color:var(--acc2);text-decoration:none;font-weight:bold;white-space:nowrap}
 .tw{overflow-x:auto}
 .tag{display:inline-block;border-radius:999px;padding:1px 9px;font-size:.75rem;font-weight:bold;white-space:nowrap}
 .tag.rep{background:var(--acc);color:#fff}
 .tag.near{background:#e7c34a;color:#3a2e05}
 tr.rep td{background:color-mix(in srgb,var(--acc) 8%,transparent)}
</style>
<div class="wrap">
 <h1>확인이 필요한 주소 <span class="badge">""" + str(len(items)) + """건</span></h1>
 <p class="lead"><b>정확한(도로명·지번) 주소를 뺀 나머지 전부</b>예요.
   <span class="tag rep">대충(대표)</span> = 동/구 대표점에 찍힘(신규택지·산번지 등),
   <span class="tag near">근처(인근)</span> = 바로 옆 번지에 찍힘(대체로 OK).
   <b>🔍 지도확인</b>으로 실제 위치를 눈으로 확인하세요.</p>
 <div class="tw"><table>
  <tr><th>주소</th><th>판정</th><th>찍힌 좌표(위도, 경도)</th><th>확인</th></tr>
  """ + '\n  '.join(rows_html) + """
 </table></div>
</div>
""")
    with open(OUT_HTML, 'w', encoding='utf-8') as f:
        f.write(doc)


if __name__ == '__main__':
    main()
