# Vercel 배포용 웹 지도 (구 · 동 · 주소 드릴다운 + 구글맵 API)

`시도 → 구 → 동 → 주소`를 눌러가며 좌르륵 볼 수 있고, 주소를 누르면 지도가 이동하며
전화·사업자번호와 **구글 길안내** 버튼이 뜹니다. 배경 지도는 **구글 지도 JavaScript API**를 씁니다.

## 구성 파일

| 파일 | 설명 |
|------|------|
| `index.html` | 드릴다운 UI + 구글맵 + 클러스터 + GPS |
| `addresses.js` | 주소 트리 데이터 (`웹데이터_생성.py`로 생성) |
| `config.js` | **여기에 구글맵 API 키 입력** |
| `markerclusterer.min.js` | 마커 클러스터러 (동봉, CDN 불필요) |
| `vercel.json` | 정적 배포 설정 |

## 1) 구글 지도 API 키 발급

1. https://console.cloud.google.com → 프로젝트 생성
2. **Maps JavaScript API** 사용 설정
3. 사용자 인증 정보 → **API 키** 발급
4. (권장) 키 제한 → *애플리케이션 제한 → HTTP 리퍼러*에 배포 도메인 추가
   예) `https://내프로젝트.vercel.app/*`
5. `config.js` 열어서 키 붙여넣기:
   ```js
   window.GOOGLE_MAPS_API_KEY = "발급받은_키";
   ```

## 2) 데이터 생성 (주소가 바뀌면 다시 실행)

```bash
python 웹데이터_생성.py     # → web/addresses.js 갱신
```
> `geocode_cache.json`(실주소_지오코딩.py 결과)이 있으면 실제 좌표를, 없으면 근사좌표를 씁니다.

## 3) Vercel 배포

**방법 A — 대시보드**
1. GitHub 저장소를 Vercel에 Import
2. **Root Directory** 를 `web` 로 지정
3. Framework Preset: *Other* (빌드 명령 없음, 정적)
4. Deploy

**방법 B — CLI**
```bash
npm i -g vercel
cd web
vercel            # 배포
vercel --prod     # 운영 배포
```

배포 후 주소창의 도메인을 4번의 API 키 리퍼러 제한에 넣어두면 키가 안전합니다.

## 참고
- 좌표가 근사치면 지도 점 위치도 근사치입니다(길안내는 실제 주소로 연결). 정확히 하려면 먼저 `실주소_지오코딩.py` 실행.
- `config.js` 에 실제 키를 넣고 커밋하면 공개 저장소에선 키가 노출됩니다. **리퍼러 제한**을 꼭 걸어두세요.
