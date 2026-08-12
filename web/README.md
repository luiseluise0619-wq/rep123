# Vercel 배포용 웹 지도 (구 · 동 · 주소 드릴다운)

`시도 → 구 → 동 → 주소`를 눌러가며 좌르륵 볼 수 있고, 주소를 누르면 지도가 이동하며
전화·사업자번호와 **구글 길안내** 버튼이 뜹니다.

> **API 키·카드 불필요.** 배경 지도는 키가 필요 없는 구글 지도 타일을 쓰고,
> 지도 라이브러리(Leaflet)는 `lib/`에 동봉되어 있어 **그냥 올리면 바로 작동**합니다.

## 구성 파일

| 파일 | 설명 |
|------|------|
| `index.html` | 드릴다운 UI + 지도 + 클러스터 + GPS |
| `addresses.js` | 주소 트리 데이터 (`웹데이터_생성.py`로 생성) |
| `lib/` | Leaflet · MarkerCluster (동봉, CDN·키 불필요) |
| `vercel.json` | 정적 배포 설정 |

## 데이터 갱신 (주소가 바뀌면)

```bash
python 웹데이터_생성.py     # → web/addresses.js 갱신
```
> `geocode_cache.json`(실주소_지오코딩.py 결과)이 있으면 실제 좌표, 없으면 근사좌표를 씁니다.

## Vercel 배포

**방법 A — 대시보드**
1. GitHub 저장소를 Vercel에 **Import**
2. **Root Directory** 를 `web` 으로 지정 ← 이거 안 하면 화면이 안 떠요
3. Framework Preset: **Other** (빌드 명령 없음, 정적)
4. **Deploy** → 끝

**방법 B — CLI**
```bash
npm i -g vercel
cd web
vercel --prod
```

## 안 될 때 체크리스트

- [ ] **Root Directory 를 `web` 으로** 지정했나? (가장 흔한 원인 — 저장소 루트로 배포하면 index.html을 못 찾음)
- [ ] `web/addresses.js` 가 커밋되어 올라갔나?
- [ ] 지도는 뜨는데 배경(지도 그림)만 안 보이면 → 인터넷/타일 접속 문제(구글 타일). 잠시 후 재시도.
- [ ] 주소 점이 근사 위치면 → `실주소_지오코딩.py` 먼저 실행 후 `웹데이터_생성.py` 재실행.
