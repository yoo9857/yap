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
- `/indexnow-key.txt`: IndexNow가 도메인 소유 여부를 확인하는 공개 검증 파일.
  로그인/API 비밀키가 아니며 파일의 값과 제출 스크립트의 검증 값이 같아야 한다.

홈페이지의 `WebSite`/`WebPage`/`VideoGame`은 같은 `@id`를 참조한다. 안내 페이지의
FAQ 구조화 데이터는 눈에 보이는 질문·답변과 일치해야 한다. 평점·사용자 수·수상
이력 등 확인되지 않은 정보는 추가하지 않는다. FAQ 마크업 자체가 Google의 FAQ
리치 결과 노출을 보장하지는 않는다.

과거 `?read=`, `?article=`, `?about=` 주소는 서버에서 301로 정리한다. 이때
`mode` 등의 게임 매개변수는 보존한다. `/guide`, `/guide/index.html`은 `/guide/`로,
`/index.html`은 `/`로 통합한다. 없는 페이지와 정적 파일은 실제 404를 반환한다.
교실·참여자·비밀번호 매개변수(`room`, `host`, `teacher`, `student`, `pass`) 또는
`preview`가 있는 HTML은 `X-Robots-Tag: noindex, nofollow`와 `Cache-Control: no-store`로
응답한다. 일반 게임 링크(`?mode=craft` 등)의 수집은 유지한다. 검색 제외는 접근
권한이나 인증을 대신하지 않는다. robots.txt로 해당 URL의 수집을 막으면 수집기가
noindex 헤더를 읽지 못하므로 robots.txt는 그대로 허용한다.

## 배포·변경 알림 자동화

GitHub Actions는 타입·린트·단위 테스트·빌드를 통과한 뒤, 빌드한 사이트를
임시 서버로 띄워 스모크 검사를 수행한다. 배포는 검사한 `github.sha`에 고정한다.
운영 배포 직후에도 공개 도메인에서 검색 메타데이터·MIME·URL·세션 검색 제외와
WebSocket을 재검사한다. 헬스체크만 성공하고 본문이 잘못된 배포를 통과시키지 않는다.

공개 페이지를 고친 배포는 `tools/notify-indexnow.mjs --changed-only`로
IndexNow에 변경을 알린다. 사이트맵의 같은 도메인 대표 URL만 허용하고, 개인 교실
쿼리·다른 호스트는 제출하지 않는다. 알림 전에 공개된 키 파일의 응답과 값을 검사한다.
일반 게임 코드만 바뀐 배포에서는 알림을 생략한다. 마지막으로 성공한 배포 실행의
커밋부터 비교하므로 이전 배포나 알림이 실패해도 변경 목록이 빠지지 않는다.
HTTP 200은 접수, 202는 키 검증 대기이며 실제 색인·검색 노출 완료를 뜻하지 않는다.
외부 API 실패는 Actions의 알림 단계 실패로 남기며 정상 배포를 되돌리지 않는다.
Google Search Console 요청은 별도로 진행한다.

```powershell
node tools/notify-indexnow.mjs --dry-run  # URL 검증·미리보기, 외부 제출 없음
node tools/notify-indexnow.mjs            # 공개 배포 확인 후 필요할 때 수동 알림
```

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
- [IndexNow 공식 프로토콜](https://www.indexnow.org/documentation)
