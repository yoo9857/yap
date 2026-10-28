# 크래프트얍 검색·AI 검색 운영

공식 한글 이름은 **크래프트얍**, 영문 이름은 **CraftYap**, 대표 주소는
**https://craftyap.com/** 이다. 본문·메타데이터·구조화 데이터에서 같은 게임을
가리켜야 한다. 검색 결과에 잘못 남았던 수익·부업 블로그 설명은 실제 HTML의
title/description/Blog 스키마에서 나온 것이었다.

## 공개되는 원문

- `/`: 게임 선택 메뉴 자체가 응답 HTML에 들어 있다. `selectMode.ts`는 이 메뉴에
  이벤트만 연결한다. 크롤러 전용 문구나 숨긴 SEO 본문을 따로 만들지 않는다.
- `/guide/`: JavaScript 없이 읽을 수 있는 공식 한글 게임 소개, 모드 비교,
  조작법, 교실 참여, 저장 방식과 FAQ. 영어 소개도 포함한다.
- `/sitemap.xml`: 위 두 개의 대표 URL만 수록한다. 실제 본문을 바꾼 날짜에만
  `lastmod`를 갱신한다. 개인 반·학생 이름이 들어간 게임 링크는 넣지 않는다.
- `/robots.txt`: 모든 수집기를 허용하며 사이트맵 주소를 안내한다.
- `/llms.txt`: 공식 페이지를 찾기 위한 보조 안내. 표준 검색 등록 수단이나 AI
  인용 보장 수단으로 취급하지 않는다. 실제 공개 안내 페이지가 정보의 기준이다.

홈페이지의 `WebSite`/`WebPage`/`VideoGame`은 같은 `@id`를 참조한다. 안내 페이지의
FAQ 구조화 데이터는 눈에 보이는 질문·답변과 일치해야 한다. 평점·사용자 수·수상
이력 등 확인되지 않은 정보는 추가하지 않는다. FAQ 마크업 자체가 Google의 FAQ
리치 결과 노출을 보장하지는 않는다.

과거 `?read=`, `?article=`, `?about=` 주소는 서버에서 301로 정리한다. 이때
`mode` 등의 게임 매개변수는 보존한다. `/guide`, `/guide/index.html`은 `/guide/`로,
`/index.html`은 `/`로 통합한다. 없는 페이지와 정적 파일은 실제 404를 반환한다.

## 배포 후 확인

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node tools/smoke-prod.mjs https://craftyap.com
```

스모크 검사는 한국어 게임 제목, 블로그 설명 제거, 스키마, 안내 페이지,
사이트맵·robots, 대표 URL 리디렉션, 404, 정적 파일과 WebSocket까지 확인한다.
게임 메뉴의 교육/게임 선택, 뒤로 가기, 안내 페이지 링크와 모바일 화면도
브라우저에서 확인한다. JavaScript를 끄거나 일반 사용자/Googlebot/Yeti/
OAI-SearchBot으로 요청해도 같은 게임 설명을 읽을 수 있어야 한다.

## 검색엔진 계정에서 필요한 작업

코드 배포와 검색엔진 등록은 별개다. 계정에 접근할 수 없으면 아래 작업을 완료했다고
보고하지 않는다. 기존 소유권 인증이 있으면 유지하며 임의의 인증 코드를 만들지 않는다.

1. Google Search Console에서 `https://craftyap.com/` 속성 소유권을 확인한다.
   사이트맵 `https://craftyap.com/sitemap.xml`을 제출하고, URL 검사로 `/`와
   `/guide/`의 게시된 URL을 확인한 뒤 색인 생성을 요청한다.
2. 네이버 서치어드바이저에서 `https://craftyap.com` 사이트의 소유권을 확인한다.
   사이트맵을 제출하고 웹 페이지 수집 요청에 `/`와 `/guide/`를 넣는다.
3. Bing Webmaster Tools를 사용하는 경우 같은 사이트맵을 등록한다.
4. 노출 보고서에서 `크래프트얍`, `CraftYap`, `크래프트얍 블록 게임`의
   노출·클릭·색인 상태를 관찰한다. `site:` 검색만으로 색인 전체를 판단하지 않는다.

재수집과 노출에는 시간이 걸리고, 등록 요청만으로 특정 검색 순위나 AI 답변의
인용을 보장할 수 없다. 이후 실제 게임 기능이 바뀌면 안내와 스키마도 함께 갱신한다.

공식 참고:
- [Google AI 검색 기능과 웹사이트](https://developers.google.com/search/docs/appearance/ai-features)
- [Google 사이트 이름](https://developers.google.com/search/docs/appearance/site-names)
- [Google 재수집 요청](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl)
- [네이버 검색엔진 최적화의 목적](https://searchadvisor.naver.com/guide/seo-basic-intro)
