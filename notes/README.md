# 개발 노트 원고

이 폴더의 `*.md` 파일 하나가 https://craftyap.com/note/ 의 노트 한 편입니다.
(이 README는 게시되지 않습니다.)

1. `notes/<주소>.md`를 만듭니다. 파일 이름이 URL이 되므로 영문 소문자·숫자·`-`만 씁니다.
   예: `notes/water-update.md` → `/note/water-update/`
2. 맨 위에 머리말을 적습니다.

   ```
   ---
   title: 물이 흐르기 시작했다
   date: 2026-10-26
   summary: 목록과 검색 결과에 보이는 한두 문장 요약.
   tags: 물, 교실
   ---
   ```

   선택 항목: `updated: YYYY-MM-DD`(고친 날), `draft: true`(아직 게시하지 않음).
3. 본문은 Markdown으로 씁니다. 이미지는 `apps/client/public/note/assets/`에 넣고
   `![설명](/note/assets/파일.webp)`로 겁니다.
4. `pnpm notes`를 실행하고 생성된 `apps/client/public/note/`와 `sitemap.xml`까지
   함께 커밋·푸시합니다. 생성물이 원고와 다르면 CI(`pnpm notes:check`)가 배포를 막습니다.
