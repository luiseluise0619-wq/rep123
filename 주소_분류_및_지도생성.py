# -*- coding: utf-8 -*-
"""
주소 데이터 정규표현식 파싱 · 분류 · 시트 분리 저장 · 모바일 구글지도 HTML 생성
================================================================================

기능 요약
    1) 주소를 정규표현식으로 파싱하여 '시도 / 구군 / 동네'로 분류
    2) '시도'별로 시트를 분리해 하나의 엑셀(지역별_주소_분류.xlsx)로 저장
       - 분류가 안 된 항목은 '기타' 시트로 모아서 저장
    3) 마커클러스터 + GPS 위치추적 + 구글 길안내가 포함된
       독립 실행형 모바일 지도(모바일_구글지도.html) 생성
       - 별도 웹 서버 없이 HTML 파일을 더블클릭하면 바로 실행
       - 배경 지도는 API 키가 필요 없는 구글 지도 타일 사용

입력 엑셀 컬럼 규약 (사용자 지정)
    A열 : 주소
    D열 : 전화번호            → 결과 파일의 G열로 정리
    E열 : 사업자 등록번호     → 결과 파일의 H열로 정리

결과 엑셀 컬럼 배치
    A:원본주소  B:시도  C:구군  D:동네  E:상세주소  F:분류상태  G:전화번호  H:사업자등록번호

주의(예외 처리)
    · 윈도우 경로 역슬래시 에러 방지를 위해 모든 경로에 r'' (raw string) 사용
    · openpyxl 사용, 모든 파일 입출력은 UTF-8 인코딩으로 처리
"""

import os
import re
import json
import html
import hashlib

from openpyxl import load_workbook, Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

# =============================================================================
# 0. 경로 설정  (윈도우 역슬래시 에러 방지를 위해 반드시 r'' 사용)
# =============================================================================
# 실행 위치(스크립트 폴더)를 기준으로 경로를 잡는다.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 입력 파일: 같은 폴더의 'exceldata1.xlsx' 를 기본값으로 사용.
#            윈도우에서 절대경로로 바꿀 때 예시:  r'C:\Users\내계정\Desktop\주소.xlsx'
INPUT_XLSX  = os.path.join(BASE_DIR, r'exceldata1.xlsx')

# 출력 파일
OUTPUT_XLSX = os.path.join(BASE_DIR, r'지역별_주소_분류.xlsx')
OUTPUT_HTML = os.path.join(BASE_DIR, r'모바일_구글지도.html')

# 입력 엑셀에서 읽어올 컬럼 인덱스(1-based)
COL_ADDR = 1   # A열 : 주소
COL_CNT  = 3   # C열 : 사업장 수 (한 주소에 여러 사업장)
COL_TEL  = 4   # D열 : 전화번호
COL_BIZ  = 5   # E열 : 사업자 등록번호

# 첫 행이 머리글이면 True 로 바꿔 한 줄 건너뛴다. (본 데이터는 머리글이 없음)
HAS_HEADER = False


# =============================================================================
# 1. 주소 분류 규칙 (정규표현식)
# =============================================================================
# 시도(광역자치단체) 목록 — 구·신 명칭을 모두 포함
SIDO_SET = {
    '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시',
    '대전광역시', '울산광역시', '세종특별자치시',
    '경기도', '강원특별자치도', '강원도', '충청북도', '충청남도',
    '전북특별자치도', '전라북도', '전라남도', '경상북도', '경상남도',
    '제주특별자치도', '제주도',
    '전남광주통합특별시',  # 본 데이터에 등장하는 통합 명칭
}

# 구군(기초자치단체): '○○시 / ○○군 / ○○구' 형태의 순수 한글 토큰
RE_GUGUN = re.compile(r'^[가-힣]+(?:시|군|구)$')

# 동네 접미사: 동·로(대로 포함)·길·리·읍·면·가
#   ‘가’(예: 북문로3가)와 중간 숫자(예: 나성북1로, 효자동1가)까지 포함해
#   기타로 빠지는 주소가 없도록 폭넓게 인식한다. (단, 첫 글자는 반드시 한글)
DONG_SUFFIX = r'(?:동|로|길|리|읍|면|가)'

# 동네: 괄호 안 법정동을 최우선으로 추출  예) "...27(남문로1가)" → 남문로1가
RE_PAREN_DONG = re.compile(r'\(\s*([가-힣][가-힣0-9]*' + DONG_SUFFIX + r')\s*(?:[,)]|$)')

# 동네: 한글로 시작하는 동·로·길·리·읍·면·가 토큰
#   (숫자로만 된 건물번호 '102동', 'S001동' 등은 첫 글자가 한글이 아니므로 제외)
RE_PURE_DONG = re.compile(r'^[가-힣][가-힣0-9]*' + DONG_SUFFIX + r'$')


def classify_address(raw):
    """
    주소 문자열을 (시도, 구군, 동네, 상세주소) 로 분해한다.
    분류 불가 항목은 해당 필드가 '' (빈 문자열)로 남는다.
    """
    addr = (raw or '').strip()
    if not addr:
        return '', '', '', ''

    tokens = addr.split()

    # --- 시도 ---
    sido = tokens[0] if tokens and tokens[0] in SIDO_SET else ''

    # --- 구군 (시도 뒤의 '시/군/구' 토큰을 최대 2개까지: 예) 수원시 팔달구) ---
    idx = 1 if sido else 0
    gugun_parts = []
    while sido and idx < len(tokens) and len(gugun_parts) < 2 and RE_GUGUN.match(tokens[idx]):
        gugun_parts.append(tokens[idx])
        idx += 1
    gugun = ' '.join(gugun_parts)

    # --- 동네 (① 괄호 안 법정동  ② 본문의 순수 한글 동/로/길/리/읍/면) ---
    dong = ''
    m = RE_PAREN_DONG.search(addr)
    if m:
        dong = m.group(1)
    else:
        for tok in tokens[idx:]:
            core = tok.rstrip(',')
            if RE_PURE_DONG.match(core):
                dong = core
                break

    # --- 상세주소 (구군 뒤의 나머지 문자열) ---
    detail = ''
    if sido:
        consumed = ' '.join(tokens[:idx])
        detail = addr[len(consumed):].strip() if consumed else addr

    return sido, gugun, dong, detail


def is_classified(sido, dong):
    """'시도'와 '동네'가 모두 잡히면 정상 분류로 본다. 아니면 '기타'."""
    return bool(sido) and bool(dong)


def clean_address_for_geocoding(addr):
    """
    지오코딩 매칭률을 높이기 위해 상세주소를 제거한 '깔끔한 주소'를 반환한다.
      · 괄호 부분 제거   예) (호암동, 우미린아파트)
      · 첫 콤마 이후 제거 예) , 1층 / , S001동 104호
    같은 건물의 여러 호실이 하나의 주소로 합쳐져 호출 수도 줄어든다.
    """
    a = re.sub(r'\(.*?\)', '', addr or '')     # 괄호 제거
    a = a.split(',')[0]                         # 첫 콤마 앞까지
    return re.sub(r'\s+', ' ', a).strip()


# =============================================================================
# 2. 지도 좌표 (오프라인·API 키 없이 표시하기 위한 행정구역 중심좌표)
# =============================================================================
# 정확한 위·경도 지오코딩은 유료 API가 필요하므로, API 키 없이 동작하도록
# '시도/구군' 중심좌표에 소량의 결정적 지터(jitter)를 더해 마커를 배치한다.
# (밀집도·클러스터 표현이 목적이며, 번지 단위의 정밀 위치가 아님)

SIDO_COORDS = {
    '서울특별시': (37.5665, 126.9780), '부산광역시': (35.1796, 129.0756),
    '대구광역시': (35.8714, 128.6014), '인천광역시': (37.4563, 126.7052),
    '광주광역시': (35.1595, 126.8526), '대전광역시': (36.3504, 127.3845),
    '울산광역시': (35.5384, 129.3114), '세종특별자치시': (36.4801, 127.2890),
    '경기도': (37.4138, 127.5183), '강원특별자치도': (37.8228, 128.1555),
    '강원도': (37.8228, 128.1555), '충청북도': (36.6357, 127.4914),
    '충청남도': (36.5184, 126.8000), '전북특별자치도': (35.7175, 127.1530),
    '전라북도': (35.7175, 127.1530), '전라남도': (34.8679, 126.9910),
    '경상북도': (36.4919, 128.8889), '경상남도': (35.4606, 128.2132),
    '제주특별자치도': (33.4890, 126.4983), '제주도': (33.4890, 126.4983),
    '전남광주통합특별시': (35.1595, 126.8526),
}

# 주요 시·군·구 중심좌표. 같은 이름(중구/서구/북구 등)이 여러 시도에 있으므로
# '시도|구군' 조합을 키로 사용한다.
GUGUN_COORDS = {
    # 서울 25개 구
    '서울특별시|종로구': (37.5730, 126.9794), '서울특별시|중구': (37.5636, 126.9976),
    '서울특별시|용산구': (37.5326, 126.9905), '서울특별시|성동구': (37.5634, 127.0369),
    '서울특별시|광진구': (37.5385, 127.0823), '서울특별시|동대문구': (37.5744, 127.0396),
    '서울특별시|중랑구': (37.6063, 127.0925), '서울특별시|성북구': (37.5894, 127.0167),
    '서울특별시|강북구': (37.6396, 127.0257), '서울특별시|도봉구': (37.6688, 127.0471),
    '서울특별시|노원구': (37.6542, 127.0568), '서울특별시|은평구': (37.6027, 126.9291),
    '서울특별시|서대문구': (37.5791, 126.9368), '서울특별시|마포구': (37.5663, 126.9016),
    '서울특별시|양천구': (37.5170, 126.8666), '서울특별시|강서구': (37.5509, 126.8495),
    '서울특별시|구로구': (37.4954, 126.8874), '서울특별시|금천구': (37.4569, 126.8956),
    '서울특별시|영등포구': (37.5264, 126.8963), '서울특별시|동작구': (37.5124, 126.9393),
    '서울특별시|관악구': (37.4784, 126.9516), '서울특별시|서초구': (37.4836, 127.0327),
    '서울특별시|강남구': (37.5172, 127.0473), '서울특별시|송파구': (37.5145, 127.1059),
    '서울특별시|강동구': (37.5301, 127.1238),
    # 부산
    '부산광역시|중구': (35.1064, 129.0323), '부산광역시|서구': (35.0979, 129.0242),
    '부산광역시|동구': (35.1295, 129.0453), '부산광역시|영도구': (35.0911, 129.0679),
    '부산광역시|부산진구': (35.1631, 129.0533), '부산광역시|동래구': (35.2049, 129.0836),
    '부산광역시|남구': (35.1366, 129.0842), '부산광역시|북구': (35.1974, 128.9903),
    '부산광역시|해운대구': (35.1631, 129.1636), '부산광역시|사하구': (35.1046, 128.9746),
    '부산광역시|금정구': (35.2429, 129.0921), '부산광역시|강서구': (35.2122, 128.9808),
    '부산광역시|연제구': (35.1763, 129.0796), '부산광역시|수영구': (35.1455, 129.1131),
    '부산광역시|사상구': (35.1524, 128.9910), '부산광역시|기장군': (35.2445, 129.2223),
    # 대구
    '대구광역시|중구': (35.8693, 128.6062), '대구광역시|동구': (35.8867, 128.6357),
    '대구광역시|서구': (35.8719, 128.5591), '대구광역시|남구': (35.8460, 128.5977),
    '대구광역시|북구': (35.8858, 128.5829), '대구광역시|수성구': (35.8582, 128.6307),
    '대구광역시|달서구': (35.8299, 128.5327), '대구광역시|달성군': (35.7746, 128.4314),
    # 인천
    '인천광역시|중구': (37.4737, 126.6215), '인천광역시|동구': (37.4738, 126.6432),
    '인천광역시|미추홀구': (37.4636, 126.6503), '인천광역시|연수구': (37.4106, 126.6784),
    '인천광역시|남동구': (37.4474, 126.7314), '인천광역시|부평구': (37.5070, 126.7219),
    '인천광역시|계양구': (37.5373, 126.7377), '인천광역시|서구': (37.5455, 126.6759),
    '인천광역시|강화군': (37.7469, 126.4877), '인천광역시|옹진군': (37.4467, 126.6369),
    # 광주
    '광주광역시|동구': (35.1460, 126.9231), '광주광역시|서구': (35.1520, 126.8901),
    '광주광역시|남구': (35.1329, 126.9024), '광주광역시|북구': (35.1741, 126.9120),
    '광주광역시|광산구': (35.1396, 126.7937),
    # 대전
    '대전광역시|동구': (36.3110, 127.4548), '대전광역시|중구': (36.3255, 127.4213),
    '대전광역시|서구': (36.3555, 127.3838), '대전광역시|유성구': (36.3623, 127.3562),
    '대전광역시|대덕구': (36.3466, 127.4155),
    # 울산
    '울산광역시|중구': (35.5694, 129.3327), '울산광역시|남구': (35.5439, 129.3300),
    '울산광역시|동구': (35.5049, 129.4165), '울산광역시|북구': (35.5827, 129.3612),
    '울산광역시|울주군': (35.5222, 129.2424),
    # 경기 주요 시
    '경기도|수원시': (37.2636, 127.0286), '경기도|고양시': (37.6584, 126.8320),
    '경기도|용인시': (37.2411, 127.1776), '경기도|성남시': (37.4200, 127.1267),
    '경기도|부천시': (37.5035, 126.7660), '경기도|화성시': (37.1996, 126.8312),
    '경기도|안산시': (37.3219, 126.8309), '경기도|남양주시': (37.6360, 127.2165),
    '경기도|안양시': (37.3943, 126.9568), '경기도|평택시': (36.9921, 127.1128),
    '경기도|시흥시': (37.3800, 126.8029), '경기도|파주시': (37.7599, 126.7800),
    '경기도|김포시': (37.6152, 126.7156), '경기도|의정부시': (37.7381, 127.0338),
    '경기도|광주시': (37.4292, 127.2551), '경기도|하남시': (37.5392, 127.2148),
    '경기도|광명시': (37.4786, 126.8646), '경기도|군포시': (37.3617, 126.9352),
    '경기도|양주시': (37.7852, 127.0458), '경기도|오산시': (37.1499, 127.0774),
    '경기도|이천시': (37.2722, 127.4350), '경기도|안성시': (37.0080, 127.2797),
    '경기도|구리시': (37.5943, 127.1296), '경기도|의왕시': (37.3448, 126.9683),
    '경기도|포천시': (37.8949, 127.2003), '경기도|양평군': (37.4917, 127.4874),
    '경기도|여주시': (37.2984, 127.6371), '경기도|동두천시': (37.9036, 127.0606),
    '경기도|가평군': (37.8315, 127.5095), '경기도|연천군': (38.0966, 127.0748),
    '경기도|과천시': (37.4292, 126.9877),
    # 강원
    '강원특별자치도|춘천시': (37.8813, 127.7300), '강원특별자치도|원주시': (37.3422, 127.9202),
    '강원특별자치도|강릉시': (37.7519, 128.8761), '강원특별자치도|동해시': (37.5247, 129.1143),
    '강원특별자치도|속초시': (38.2070, 128.5918), '강원특별자치도|삼척시': (37.4499, 129.1655),
    '강원특별자치도|태백시': (37.1640, 128.9856), '강원특별자치도|홍천군': (37.6971, 127.8886),
    '강원특별자치도|횡성군': (37.4917, 127.9850), '강원특별자치도|영월군': (37.1836, 128.4616),
    '강원특별자치도|평창군': (37.3705, 128.3902), '강원특별자치도|정선군': (37.3806, 128.6608),
    '강원특별자치도|철원군': (38.1466, 127.3134), '강원특별자치도|화천군': (38.1063, 127.7081),
    '강원특별자치도|양구군': (38.1099, 127.9899), '강원특별자치도|인제군': (38.0697, 128.1707),
    '강원특별자치도|고성군': (38.3806, 128.4678), '강원특별자치도|양양군': (38.0754, 128.6190),
    # 충북
    '충청북도|청주시': (36.6424, 127.4890), '충청북도|충주시': (36.9910, 127.9260),
    '충청북도|제천시': (37.1326, 128.1910), '충청북도|보은군': (36.4894, 127.7295),
    '충청북도|옥천군': (36.3064, 127.5713), '충청북도|영동군': (36.1750, 127.7764),
    '충청북도|증평군': (36.7855, 127.5815), '충청북도|진천군': (36.8553, 127.4355),
    '충청북도|괴산군': (36.8153, 127.7866), '충청북도|음성군': (36.9403, 127.6906),
    '충청북도|단양군': (36.9846, 128.3655),
    # 충남
    '충청남도|천안시': (36.8151, 127.1139), '충청남도|공주시': (36.4465, 127.1189),
    '충청남도|보령시': (36.3333, 126.6127), '충청남도|아산시': (36.7898, 127.0018),
    '충청남도|서산시': (36.7848, 126.4503), '충청남도|논산시': (36.1872, 127.0987),
    '충청남도|계룡시': (36.2745, 127.2487), '충청남도|당진시': (36.8899, 126.6457),
    '충청남도|금산군': (36.1088, 127.4881), '충청남도|부여군': (36.2757, 126.9098),
    '충청남도|서천군': (36.0803, 126.6919), '충청남도|청양군': (36.4592, 126.8020),
    '충청남도|홍성군': (36.6014, 126.6608), '충청남도|예산군': (36.6809, 126.8449),
    '충청남도|태안군': (36.7456, 126.2979),
    # 전북
    '전북특별자치도|전주시': (35.8242, 127.1480), '전북특별자치도|군산시': (35.9676, 126.7369),
    '전북특별자치도|익산시': (35.9483, 126.9576), '전북특별자치도|정읍시': (35.5699, 126.8558),
    '전북특별자치도|남원시': (35.4164, 127.3905), '전북특별자치도|김제시': (35.8036, 126.8809),
    '전북특별자치도|완주군': (35.9047, 127.1620), '전북특별자치도|진안군': (35.7917, 127.4249),
    '전북특별자치도|무주군': (36.0071, 127.6608), '전북특별자치도|장수군': (35.6473, 127.5213),
    '전북특별자치도|임실군': (35.6177, 127.2891), '전북특별자치도|순창군': (35.3744, 127.1376),
    '전북특별자치도|고창군': (35.4358, 126.7020), '전북특별자치도|부안군': (35.7318, 126.7333),
    # 전남
    '전라남도|목포시': (34.8118, 126.3922), '전라남도|여수시': (34.7604, 127.6622),
    '전라남도|순천시': (34.9506, 127.4872), '전라남도|나주시': (35.0160, 126.7108),
    '전라남도|광양시': (34.9407, 127.6960), '전라남도|담양군': (35.3211, 126.9880),
    '전라남도|곡성군': (35.2820, 127.2919), '전라남도|구례군': (35.2024, 127.4629),
    '전라남도|고흥군': (34.6111, 127.2850), '전라남도|보성군': (34.7714, 127.0800),
    '전라남도|화순군': (35.0645, 126.9866), '전라남도|장흥군': (34.6816, 126.9070),
    '전라남도|강진군': (34.6420, 126.7672), '전라남도|해남군': (34.5734, 126.5990),
    '전라남도|영암군': (34.8001, 126.6969), '전라남도|무안군': (34.9902, 126.4817),
    '전라남도|함평군': (35.0658, 126.5165), '전라남도|영광군': (35.2772, 126.5120),
    '전라남도|장성군': (35.3019, 126.7889), '전라남도|완도군': (34.3110, 126.7549),
    '전라남도|진도군': (34.4867, 126.2634), '전라남도|신안군': (34.8272, 126.3517),
    '전라남도|고성군': (34.9730, 128.3222),
    # 경북
    '경상북도|포항시': (36.0190, 129.3435), '경상북도|경주시': (35.8562, 129.2247),
    '경상북도|김천시': (36.1398, 128.1136), '경상북도|안동시': (36.5684, 128.7294),
    '경상북도|구미시': (36.1196, 128.3446), '경상북도|영주시': (36.8057, 128.6240),
    '경상북도|영천시': (35.9733, 128.9386), '경상북도|상주시': (36.4109, 128.1590),
    '경상북도|문경시': (36.5866, 128.1867), '경상북도|경산시': (35.8251, 128.7413),
    '경상북도|군위군': (36.2429, 128.5729), '경상북도|의성군': (36.3527, 128.6971),
    '경상북도|청송군': (36.4362, 129.0570), '경상북도|영양군': (36.6667, 129.1124),
    '경상북도|영덕군': (36.4152, 129.3656), '경상북도|청도군': (35.6474, 128.7341),
    '경상북도|고령군': (35.7259, 128.2628), '경상북도|성주군': (35.9192, 128.2831),
    '경상북도|칠곡군': (35.9955, 128.4017), '경상북도|예천군': (36.6576, 128.4527),
    '경상북도|봉화군': (36.8932, 128.7325), '경상북도|울진군': (36.9930, 129.4005),
    '경상북도|울릉군': (37.4844, 130.9057),
    # 경남
    '경상남도|창원시': (35.2280, 128.6811), '경상남도|진주시': (35.1800, 128.1076),
    '경상남도|통영시': (34.8544, 128.4331), '경상남도|사천시': (35.0034, 128.0642),
    '경상남도|김해시': (35.2285, 128.8894), '경상남도|밀양시': (35.5038, 128.7466),
    '경상남도|거제시': (34.8807, 128.6212), '경상남도|양산시': (35.3350, 129.0378),
    '경상남도|의령군': (35.3222, 128.2617), '경상남도|함안군': (35.2725, 128.4066),
    '경상남도|창녕군': (35.5445, 128.4923), '경상남도|고성군': (34.9730, 128.3222),
    '경상남도|남해군': (34.8376, 127.8925), '경상남도|하동군': (35.0672, 127.7514),
    '경상남도|산청군': (35.4155, 127.8735), '경상남도|함양군': (35.5205, 127.7251),
    '경상남도|거창군': (35.6866, 127.9095), '경상남도|합천군': (35.5666, 128.1655),
    # 제주
    '제주특별자치도|제주시': (33.4996, 126.5312), '제주특별자치도|서귀포시': (33.2542, 126.5600),
    # 세종
    '세종특별자치시|세종특별자치시': (36.4801, 127.2890),
}


def _jitter(seed_text, scale=0.012):
    """주소 문자열 해시로 좌표를 소량 흔들어 겹침을 분산(결정적·재현 가능)."""
    h = hashlib.md5(seed_text.encode('utf-8')).hexdigest()
    dx = (int(h[0:8], 16) / 0xFFFFFFFF - 0.5) * 2 * scale
    dy = (int(h[8:16], 16) / 0xFFFFFFFF - 0.5) * 2 * scale
    return dx, dy


# 전국 읍면동 중심좌표 (emd_centroids.json) 로드 — 있으면 '동 단위'로 정밀 배치
_EMD_PATH = os.path.join(BASE_DIR, r'emd_centroids.json')
try:
    with open(_EMD_PATH, 'r', encoding='utf-8') as _f:
        DONG_CENTROIDS = json.load(_f)   # {동base이름: [[lat,lng], ...]}
except (OSError, ValueError):
    DONG_CENTROIDS = {}


# '대략(확인필요)' 주소 목록 — 실좌표가 있어도 위치가 인근/대표점이라 부정확한 것들.
# gimi9_병합.py 가 approx_addrs.json(정리주소 키 리스트)을 써두면 여기서 읽어
# 지도/웹에서 주황(대략)으로 구분 표시한다.
_APPROX_PATH = os.path.join(BASE_DIR, r'approx_addrs.json')


def load_approx_keys():
    """{정리주소, ...} 집합을 반환. 파일 없으면 빈 집합."""
    try:
        with open(_APPROX_PATH, 'r', encoding='utf-8') as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def _dong_base(dong):
    """행정동/법정동 이름에서 숫자·구분점을 떼어 매칭용 기준 이름으로."""
    if not dong:
        return ''
    return re.sub(r'[0-9]', '', dong).replace('.', '').replace('·', '')


def _ref_point(sido, gugun):
    """동명 중복(같은 이름 여러 지역) 해소를 위한 기준점: 구 → 시도 중심."""
    if gugun:
        p = GUGUN_COORDS.get('%s|%s' % (sido, gugun.split()[0]))
        if p:
            return p
    return SIDO_COORDS.get(sido)


def locate(sido, gugun, raw, dong=None):
    """
    위·경도와 정밀도 등급을 (lat, lng, level) 로 반환. 못 찾으면 None.
      level='dong' : 읍면동 중심좌표(정밀)  /  'gu' : 시군구·시도 중심(대략)
    """
    # 1) 동 단위 (가장 정밀) — emd_centroids.json 매칭
    cands = DONG_CENTROIDS.get(_dong_base(dong)) if dong else None
    if cands:
        if len(cands) == 1:
            center = cands[0]
        else:
            ref = _ref_point(sido, gugun)
            center = (min(cands, key=lambda c: (c[0]-ref[0])**2 + (c[1]-ref[1])**2)
                      if ref else cands[0])
        dlat, dlng = _jitter(raw, 0.0035)   # 동 내부에 촘촘히 흩뿌림
        return round(center[0] + dlat, 6), round(center[1] + dlng, 6), 'dong'

    # 2) 시군구·시도 폴백 (대략)
    base = None
    if gugun:
        base = GUGUN_COORDS.get('%s|%s' % (sido, gugun.split()[0]))
    if base is None:
        base = SIDO_COORDS.get(sido)
    if base is None:
        return None
    dlat, dlng = _jitter(raw)
    return round(base[0] + dlat, 6), round(base[1] + dlng, 6), 'gu'


# =============================================================================
# 3. 엑셀 읽기
# =============================================================================
def read_rows(path):
    """입력 엑셀에서 (주소, 전화번호, 사업자등록번호) 목록을 읽는다."""
    print('[1/4] 엑셀 읽는 중 :', path)
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = []
    for r_i, row in enumerate(ws.iter_rows(values_only=True)):
        if HAS_HEADER and r_i == 0:
            continue

        def cell(idx):
            i = idx - 1
            return row[i] if i < len(row) and row[i] is not None else ''

        addr = str(cell(COL_ADDR)).strip()
        if not addr:
            continue
        tel = str(cell(COL_TEL)).strip()
        biz = str(cell(COL_BIZ)).strip()
        cnt_raw = cell(COL_CNT)
        try:
            cnt = int(float(cnt_raw)) if str(cnt_raw).strip() != '' else 1
        except (ValueError, TypeError):
            cnt = 1
        rows.append((addr, tel, biz, cnt))
    wb.close()
    print('      → 총 %d 건' % len(rows))
    return rows


# =============================================================================
# 4. 시도별 시트 분리 엑셀 저장
# =============================================================================
HEADERS = ['원본주소', '시도', '구군', '동네', '상세주소', '분류상태', '사업장수']

# 시트 정렬 순서 (자주 쓰는 시도 우선)
SIDO_ORDER = [
    '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시',
    '울산광역시', '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도',
    '전북특별자치도', '전라남도', '경상북도', '경상남도', '제주특별자치도', '전남광주통합특별시',
]


def _safe_sheet_title(name):
    """엑셀 시트명 제한(31자, 특수문자 금지) 처리."""
    for ch in r'[]:*?/\\':
        name = name.replace(ch, '_')
    return name[:31] if name else '기타'


def save_classified_xlsx(records, path):
    """records: [ {시도,구군,동네,상세,상태,주소,전화,사업자}, ... ] 를 시트별로 저장."""
    print('[3/4] 지역별 엑셀 저장 중 :', path)

    # 시도별로 묶기 (분류 실패는 '기타')
    groups = {}
    for rec in records:
        key = rec['시도'] if rec['상태'] == '정상' else '기타'
        groups.setdefault(key, []).append(rec)

    wb = Workbook()
    wb.remove(wb.active)  # 기본 시트 제거

    header_font = Font(bold=True, color='FFFFFF')
    header_fill = PatternFill('solid', fgColor='2F5597')
    center = Alignment(horizontal='center', vertical='center')

    # 시트 순서: 지정 순서 → 나머지 → '기타' 는 항상 마지막
    ordered = [s for s in SIDO_ORDER if s in groups]
    ordered += [s for s in groups if s not in ordered and s != '기타']
    if '기타' in groups:
        ordered.append('기타')

    for sido in ordered:
        ws = wb.create_sheet(_safe_sheet_title(sido))
        ws.append(HEADERS)
        for c_i in range(1, len(HEADERS) + 1):
            cell = ws.cell(row=1, column=c_i)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = center

        for rec in groups[sido]:
            ws.append([
                rec['주소'], rec['시도'], rec['구군'], rec['동네'],
                rec['상세'], rec['상태'], rec.get('사업장수', 1),
            ])

        # 보기 좋게: 머리글 고정 + 열 너비
        ws.freeze_panes = 'A2'
        widths = [42, 12, 16, 10, 30, 8, 8]
        for c_i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(c_i)].width = w

        print('      · %-14s %6d 건' % (sido, len(groups[sido])))

    wb.save(path)
    print('      → 저장 완료 (시트 %d개)' % len(ordered))


# =============================================================================
# 5. 모바일 구글지도 HTML 생성
# =============================================================================
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0"/>
<title>모바일 주소 지도 (__COUNT__건)</title>

<!-- Leaflet + MarkerCluster (오프라인 인라인 또는 CDN) -->
__HEAD_ASSETS__

<style>
  html, body { margin:0; height:100%; font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif; }
  #map { position:absolute; top:0; bottom:0; left:0; right:0; }
  .info-badge {
    position:absolute; top:10px; left:10px; z-index:1000;
    background:rgba(255,255,255,.92); padding:7px 12px; border-radius:10px;
    box-shadow:0 2px 6px rgba(0,0,0,.3); font-size:13px; font-weight:bold; color:#222;
  }
  .gps-btn {
    position:absolute; right:14px; bottom:28px; z-index:1000;
    width:56px; height:56px; border:none; border-radius:50%;
    background:#fff; box-shadow:0 3px 8px rgba(0,0,0,.35);
    font-size:26px; cursor:pointer; display:flex; align-items:center; justify-content:center;
  }
  .gps-btn:active { transform:scale(.94); }
  .popup-addr { font-size:14px; line-height:1.5; margin-bottom:8px; color:#222; word-break:keep-all; }
  .popup-sub  { font-size:12px; color:#666; margin-bottom:8px; }
  .nav-btn {
    display:block; text-align:center; text-decoration:none;
    background:#1a73e8; color:#fff; padding:9px 12px; border-radius:8px;
    font-size:14px; font-weight:bold;
  }
  .my-dot {
    width:18px; height:18px; background:#e53935; border:3px solid #fff;
    border-radius:50%; box-shadow:0 0 6px rgba(229,57,53,.9);
  }
  /* 마커: 이미지 없이 CSS 원형 점 (4만+ 건 렌더링 경량화) */
  .addr-dot {
    width:12px; height:12px; background:#1a73e8; border:2px solid #fff;
    border-radius:50%; box-shadow:0 1px 2px rgba(0,0,0,.4);
  }
  .addr-dot.approx { background:#f39c12; }   /* 근사좌표(변환 실패) = 주황 */
  .legend { position:absolute; left:10px; bottom:14px; z-index:1000;
    background:rgba(255,255,255,.92); padding:6px 10px; border-radius:8px;
    box-shadow:0 2px 6px rgba(0,0,0,.3); font-size:12px; color:#333; }
  .legend b { font-weight:bold; }
  .dotb { display:inline-block; width:10px; height:10px; border-radius:50%; vertical-align:middle; margin-right:3px; }
</style>
</head>
<body>
<div id="map"></div>
<div class="info-badge">📍 주소 __COUNT__건 · 마커를 눌러 길안내</div>
<div class="legend" id="legend"><span class="dotb" style="background:#1a73e8"></span>정밀(동) <b id="nReal">-</b>
  &nbsp; <span class="dotb" style="background:#f39c12"></span>대략(구) <b id="nApprox">-</b></div>
<button class="gps-btn" id="gpsBtn" title="내 위치 찾기">🎯</button>

<script>
// ── 주소 좌표 데이터 (파이썬이 삽입) ─────────────────────────────
// 각 항목: [위도, 경도, "주소", "전화번호"]
var POINTS = __DATA__;

// ── 지도 초기화 : API 키가 필요 없는 구글 지도 타일 사용 ──────────
var map = L.map('map', { zoomControl:true, preferCanvas:true }).setView([36.5, 127.8], 7);

L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
  subdomains:['0','1','2','3'],
  maxZoom:20,
  attribution:'&copy; Google Maps'
}).addTo(map);

// ── 마커 클러스터 (4만 건 이상도 튕기지 않도록 청크 로딩) ─────────
var cluster = L.markerClusterGroup({
  chunkedLoading:true,
  chunkInterval:200,
  chunkDelay:20,
  maxClusterRadius:60,
  disableClusteringAtZoom:17,
  removeOutsideVisibleBounds:true
});

function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

var dotReal   = L.divIcon({ className:'', html:'<div class="addr-dot"></div>', iconSize:[12,12], iconAnchor:[6,6] });
var dotApprox = L.divIcon({ className:'', html:'<div class="addr-dot approx"></div>', iconSize:[12,12], iconAnchor:[6,6] });

var nReal=0, nApprox=0;
var markers = [];
for (var i=0; i<POINTS.length; i++){
  var p = POINTS[i];
  var real = p[4] ? true : false;
  if(real) nReal++; else nApprox++;
  var m = L.marker([p[0], p[1]], {icon: real ? dotReal : dotApprox});
  m._d = p;                       // 팝업 내용은 클릭 시 생성(메모리 절약)
  m.on('click', function(e){
    var d = e.target._d;
    var addr = esc(d[2]), cnt = d[3] || 1;
    var q = encodeURIComponent(d[2]);
    // 실제 주소 문자열로 구글에 연동 (근사좌표 아님)
    var navUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + q;   // 길안내
    var searchUrl = 'https://www.google.com/maps/search/?api=1&query=' + q;   // 구글지도 검색
    var htmlStr =
      '<div class="popup-addr">' + addr + '</div>' +
      (cnt > 1 ? '<div class="popup-sub" style="color:#d93025;font-weight:bold">🏬 이 주소 사업장 ' + cnt + '개</div>' : '') +
      '<a class="nav-btn" href="' + searchUrl + '" target="_blank" rel="noopener">🔍 구글지도에서 열기</a>' +
      '<a class="nav-btn" style="background:#34a853;margin-top:6px" href="' + navUrl + '" target="_blank" rel="noopener">🚗 구글 길안내</a>';
    e.target.bindPopup(htmlStr, {maxWidth:260}).openPopup();
  });
  markers.push(m);
}
cluster.addLayers(markers);
map.addLayer(cluster);
document.getElementById('nReal').textContent = nReal.toLocaleString();
document.getElementById('nApprox').textContent = nApprox.toLocaleString();

// ── 실시간 GPS 내 위치 추적 (빨간 마커) ─────────────────────────
var myMarker = null, watchId = null;
var redIcon = L.divIcon({ className:'', html:'<div class="my-dot"></div>', iconSize:[18,18], iconAnchor:[9,9] });

document.getElementById('gpsBtn').addEventListener('click', function(){
  if (!navigator.geolocation){ alert('이 브라우저는 위치 기능을 지원하지 않습니다.'); return; }
  if (watchId !== null){ navigator.geolocation.clearWatch(watchId); watchId = null; }
  this.textContent = '⏳';
  var btn = this;
  watchId = navigator.geolocation.watchPosition(
    function(pos){
      btn.textContent = '🎯';
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      if (myMarker){ myMarker.setLatLng([lat,lng]); }
      else { myMarker = L.marker([lat,lng], {icon:redIcon, zIndexOffset:1000})
                         .addTo(map).bindPopup('📍 현재 내 위치'); }
      map.setView([lat,lng], 16);
    },
    function(err){
      btn.textContent = '🎯';
      alert('위치를 가져올 수 없습니다: ' + err.message);
    },
    { enableHighAccuracy:true, maximumAge:5000, timeout:10000 }
  );
});
</script>
</body>
</html>
"""


# vendor 폴더에 라이브러리가 있으면 HTML 안에 인라인(완전 자립형),
# 없으면 CDN 링크로 대체한다.
VENDOR_DIR = os.path.join(BASE_DIR, r'vendor')
CDN_ASSETS = (
    '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>\n'
    '<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"/>\n'
    '<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"/>\n'
    '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>\n'
    '<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>'
)


def _read(fn):
    with open(os.path.join(VENDOR_DIR, fn), 'r', encoding='utf-8') as f:
        return f.read()


def build_head_assets():
    """가능하면 라이브러리를 인라인, 아니면 CDN 링크 반환."""
    need = ['leaflet.css', 'MarkerCluster.css', 'MarkerCluster.Default.css',
            'leaflet.js', 'leaflet.markercluster.js']
    if all(os.path.exists(os.path.join(VENDOR_DIR, f)) for f in need):
        parts = ['<style>%s</style>' % _read('leaflet.css'),
                 '<style>%s</style>' % _read('MarkerCluster.css'),
                 '<style>%s</style>' % _read('MarkerCluster.Default.css'),
                 '<script>%s</script>' % _read('leaflet.js'),
                 '<script>%s</script>' % _read('leaflet.markercluster.js')]
        print('      · 라이브러리 인라인(오프라인 자립형)')
        return '\n'.join(parts)
    print('      · vendor 폴더 없음 → CDN 링크 사용(인터넷 필요)')
    return CDN_ASSETS


def save_map_html(records, path, coord_lookup=None):
    """분류된 좌표를 담은 독립 실행형 모바일 지도 HTML을 생성.

    coord_lookup : {주소문자열: (위도, 경도)}  실제 지오코딩 좌표.
                   해당 주소가 있으면 근사좌표 대신 실제 좌표를 사용한다.
    """
    print('[4/4] 모바일 지도 HTML 생성 중 :', path)
    approx_keys = load_approx_keys()   # 인근/대표점이라 부정확한 주소들(주황 표시)
    points = []
    skipped = 0
    n_good = 0
    for rec in records:
        lat = lng = None
        good = 0                       # 1 = 실좌표/동단위(정밀), 0 = 대략(구단위·인근·대표)
        v = coord_lookup.get(rec['주소']) if coord_lookup else None
        if v:                          # 실좌표(캐시)
            lat, lng = v[0], v[1]
            good = 0 if clean_address_for_geocoding(rec['주소']) in approx_keys else 1
        else:
            loc = locate(rec['시도'], rec['구군'], rec['주소'], dong=rec['동네'])
            if loc:
                lat, lng, level = loc
                good = 1 if level == 'dong' else 0
        if lat is None:
            skipped += 1
            continue
        if good:
            n_good += 1
        points.append([round(lat, 6), round(lng, 6), rec['주소'], rec.get('사업장수', 1), good])
    print('      · 정밀(동/실좌표) %d건 / 대략(구단위) %d건' % (n_good, len(points) - n_good))

    # ensure_ascii=False 로 한글을 그대로 담고 UTF-8 로 저장
    data_json = json.dumps(points, ensure_ascii=False, separators=(',', ':'))
    html_str = (HTML_TEMPLATE
                .replace('__HEAD_ASSETS__', build_head_assets())
                .replace('__DATA__', data_json)
                .replace('__COUNT__', format(len(points), ',')))

    with open(path, 'w', encoding='utf-8') as f:
        f.write(html_str)

    print('      → 지도 표시 %d건 (좌표 없음 %d건 제외)' % (len(points), skipped))


# =============================================================================
# 6. 메인
# =============================================================================
def build_records(rows):
    """(주소, 전화, 사업자, 사업장수) 목록 → 분류된 레코드 목록."""
    records = []
    ok = 0
    for row in rows:
        addr, tel, biz = row[0], row[1], row[2]
        cnt = row[3] if len(row) > 3 else 1
        sido, gugun, dong, detail = classify_address(addr)
        status = '정상' if is_classified(sido, dong) else '기타'
        if status == '정상':
            ok += 1
        records.append({
            '주소': addr, '시도': sido, '구군': gugun, '동네': dong,
            '상세': detail, '상태': status, '전화': tel, '사업자': biz,
            '사업장수': cnt,
        })
    return records, ok


def main():
    if not os.path.exists(INPUT_XLSX):
        raise FileNotFoundError('입력 엑셀을 찾을 수 없습니다: %s' % INPUT_XLSX)

    rows = read_rows(INPUT_XLSX)

    print('[2/4] 주소 분류 중 ...')
    records, ok = build_records(rows)
    print('      → 정상 %d건 / 기타 %d건' % (ok, len(records) - ok))

    save_classified_xlsx(records, OUTPUT_XLSX)
    save_map_html(records, OUTPUT_HTML)

    print('\n[완료] 결과 파일')
    print('   · 엑셀 :', OUTPUT_XLSX)
    print('   · 지도 :', OUTPUT_HTML)


if __name__ == '__main__':
    main()
