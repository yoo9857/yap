# 로보 월드 (Robo World)

로블록스 스타일 풀 3D 블록 게임 모음. 접속하면 모드를 고릅니다:

1. **🗼 오늘의 타워** — 멀티플레이 점프맵(오비). **매일 자정(KST)에 새 타워**가 열리고, 전 세계가 같은 타워를 올라 서버가 검증·영속화한 기록으로 데일리 리더보드를 겨룹니다.
2. **🏗️ 로보 빌더** — 방치형 **세계 랜드마크 건설**. 반투명 청사진(고스트)이 목표를 보여주고, R6 인부들이 벽돌 꾸러미를 날라 복셀 랜드마크를 채워갑니다: 피라미드 → 빅벤 → 피사의 사탑 → 에펠탑 → 콜로세움 → 남산서울타워 → 자유의 여신상 (랜드마크당 1,600~3,800 복셀, 시계판·아치·로브 주름까지 절차 생성). 완주 후엔 배율이 붙는 다음 투어. 물리·서버 불필요(localStorage 저장), 오프라인 정산으로 자리를 비워도 계속 자랍니다.

`legacy/index.html`의 2.5D 프로토타입을 게임 감각(물리 상수·난이도 곡선) 그대로 풀 3D로 재구축한 코드베이스 위에, 두 게임이 렌더러·캐릭터 릭·사운드·이펙트를 공유합니다. 타워 모드의 Rapier WASM(2MB)은 타워 선택 시에만 로드됩니다.

## 기술 스택

| 영역 | 스택 |
|---|---|
| 클라이언트 | Three.js + TypeScript(strict) + Vite |
| 물리 | Rapier 3D (`@dimforge/rapier3d-compat`, KinematicCharacterController) |
| 서버 | Node.js 22 + `ws` + pino, tsup 번들 |
| 공유 코드 | `@robo/shared` — zod 프로토콜, 결정적 레벨 생성기 (소스 그대로 소비, 빌드 없음) |
| 품질 | Vitest(33 유닛 테스트) + ESLint(typed) + puppeteer E2E |

## 실행

```bash
pnpm install
pnpm dev          # 서버(:8081) + 클라(:5173, /ws 프록시) 동시 기동
```

브라우저에서 http://localhost:5173 → 닉네임 입력 → 게임 시작. 탭 두 개를 열면 서로 보입니다.

- 이동 `WASD` · 점프 `Space` · 리스폰 `R` · 드래그 카메라 회전 · 휠 줌
- 모바일: 왼쪽 가상 조이스틱 + 점프 버튼

## 프로덕션

```bash
pnpm build
SERVE_STATIC=1 node apps/server/dist/index.js   # 단일 포트(:8081)로 정적+WS 서빙
```

환경변수: `PORT`, `SNAPSHOT_HZ`, `MAX_PLAYERS_PER_ROOM`, `SERVE_STATIC`, `STATIC_DIR`, `LOG_LEVEL` (`apps/server/src/config.ts`).

## 검증

```bash
pnpm typecheck && pnpm lint && pnpm test   # 정적 게이트 + 유닛 테스트

# E2E (pnpm dev 실행 중이어야 함, headless Edge 사용)
node tools/e2e-mechanics.mjs     # 타워: 이동발판 탑승/붕괴/킬브릭/체크포인트/골
node tools/e2e-multiplayer.mjs   # 타워: 두 탭 상호 관측 + 발판 타임라인 동기 + 데일리 보드
node tools/e2e-robustness.mjs    # 타워: 치트 스냅백/킥, 서버 재시작 복구, 기록 영속
node tools/e2e-builder.mjs       # 빌더: 부팅→골드→상점→목표 체인→오프라인 정산 정밀 일치
node tools/e2e-production.mjs    # pnpm build 후 단일 포트 배포 검증 (dev 서버 불필요)
```

## 데일리 타워 (초정밀 설계)

- **시드 = f(날짜)**: `dailySeed(dateStr)`(`packages/shared/src/daily.ts`)로 클라·서버·오프라인 클라이언트가 독립적으로 같은 타워를 유도. 서버 welcome이 권위(시드 불일치 시 클라가 레벨을 라이브 재구축).
- **공유 발판 타임라인**: 이동 발판은 "서버 시간 기준 그날의 경과 초"로만 계산 — 모든 클라이언트가 동일 위상 (E2E 실측 오차 ≈1ms). 클라는 슬루 제한 단조 타임라인(`app/timeline.ts`)으로 물리에 공급해 시계 보정이 발밑을 튕기지 않게 함.
- **정밀 기록**: 타이머는 스폰 이탈 틱부터(클라/서버 동일 규칙). 클라의 틱 정밀(16.7ms) 측정치를 서버가 벽시계 창(±max(1s, 5%))으로 교차 검증해 채택. 기록은 SQLite(`apps/server/data/records.db`)에 날짜·이름별 최고만 upsert — 재시작에도 유지.
- **자정 롤오버**: 서버가 매초 검사, 접속자에게 `s-notice` 브로드캐스트. 진행 중인 룸은 유지되고 신규 입장만 새 타워로. 오프라인 클라도 로컬 시계로 롤오버.
- **치트 앵커**: 리스폰 텔레포트는 "도달한 체크포인트/스폰 8m 이내"로만 허용 — 리스폰 스팸 비행 원천 차단. 첫 위치 보고도 스폰 앵커 필수.

## 아키텍처 핵심

- **고정 60Hz 시뮬레이션 + 렌더 보간**: 물리는 항상 1/60초 스텝, 렌더되는 모든 것(플레이어·발판)은 동일한 prev/curr 쌍에서 보간 — 탑승 지터 방지의 핵심 규칙 (`apps/client/src/app/loop.ts`, `physics/interpolation.ts`).
- **틱 순서 계약** (`app/game.ts`): 입력 샘플 → 이동발판 순간이동 → 플레이어 KCC(+탑승 델타) → `world.step()` 1회 → 트리거/NaN 감시 → 보간 커밋.
- **이동발판 탑승**: 발판은 `setTranslation`(순간이동)으로 구동 — `setNextKinematicTranslation`은 내부 속도를 만들어 Rapier KCC가 라이더를 불완전하게 이중 운반하는 문제가 있음(틱 트레이스로 검증). 명시적 델타 주입이 유일한 운반 경로 (`world/platforms.ts`, `player/controller.ts`).
- **클라이언트 권한 이동 + 서버 sanity 검증**: 클라가 20Hz로 위치 보고, 서버는 수락된 상태 간 벽시계 변위로 검증(랙 오탐 방지), 위반 시 소프트 스냅백 → 감쇠 점수 → 킥 (`apps/server/src/game/validation.ts` — 순수 함수, 유닛 테스트 완비).
- **결정적 레벨**: `generateLevel(seed)`가 클라·서버에서 동일한 타워 생성. 이동발판 위치는 절대 시간 해석해로만 계산(드리프트 0, 서버가 동일 계산 가능).
- **예외 처리**: WASM init 실패 오버레이, WS 지수 백오프 무한 재접속(끊겨도 솔로 플레이 지속), zod 양방향 검증, NaN 워치독, 붕괴 발판은 클라 로컬 FSM(동기화 불필요), 서버는 룸별 try/catch + graceful shutdown.

## 알려진 제한

- 런 도중 재접속하면 서버 쪽 체크포인트 진행이 초기화됨(다시 도전으로 회복).
- 백그라운드 탭은 시뮬레이션이 일시정지됨(브라우저 rAF 제약).
- 닉네임이 곧 신원(계정 없음) — 같은 이름은 같은 기록 슬롯을 공유.
- 속도 검증은 순간이 아닌 구간 속도 상한 방식이라, 상한(수평 15.7·수직 32 m/s) 내 "빠른 활강"은 통과함 — 단 최소 완주 시간·체크포인트 순서가 기록 조작을 하한으로 막음.
- 타이틀 리더보드는 첫 접속(게임 시작) 이후부터 채워짐.
