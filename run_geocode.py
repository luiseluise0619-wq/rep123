# -*- coding: utf-8 -*-
"""
더블클릭 실행용 런처(ASCII 이름) — 한글 파일명 배치 문제 회피.
실제 작업은 실주소_지오코딩.py 의 main() 이 수행한다.
"""
import os
import importlib.util

BASE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    'geocode_impl', os.path.join(BASE, '실주소_지오코딩.py'))
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)

if __name__ == '__main__':
    try:
        _m.main()
    except SystemExit as e:
        print('\n[중단]', e)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print('\n[오류]', e)
