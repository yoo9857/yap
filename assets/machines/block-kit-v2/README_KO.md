# CraftYap 조립 부품 · 학습 작업대 2.0

2026-11-03. 자동차를 이루는 8종 부품을 직접 만든 Blender 메시와 UV·재질로 교체하고, 조립한 부품 하나하나의 색과 물리 설정을 게임에서 바꿀 수 있게 했습니다.

## 직접 확인하기

- `review.html`: 인터넷 연결 없이 열 수 있는 3D 검수 화면. 실제 게임의 모델·부품 표시·설정 코드를 사용합니다. 전체 자동차와 부품 확대 보기, 정면·측면·바퀴 안쪽 보기, 색과 설정 변경을 제공합니다. 금색 테두리가 선택한 부품입니다.
- 게임: `B`로 기계 작업실을 열고 **조립한 부품 조정(V)** → 조립된 부품 클릭 또는 목록 선택 → 설정 변경 → `Enter`로 시험 운전. 주행 중에는 편집이 잠깁니다.
- 좌우 함께 바꾸기를 켜면 대칭 위치의 같은 종류 부품도 바뀝니다. 끄면 한 부품만 바뀝니다. 실행 취소·다시 실행, 자동 저장, 설계도 공유에도 설정을 보존합니다.
- `source/CraftYap_MachineKit_Learning.blend`: 부품을 나란히 배치한 Blender 원본. `CraftYap_MachineKit_v2.blend`에는 게임용 HQ/LOD1 라이브러리와 조립 차량 장면을 보관합니다.

## 아이들이 비교할 수 있는 설정

모든 부품에 7가지 색을 제공합니다. 색은 성능에 영향을 주지 않습니다. 숫자와 질문을 함께 표시하며 한 번에 한 설정을 바꾸어 비교하도록 안내합니다.

| 부품 | 바꿀 수 있는 값 | 게임에 적용되는 변화와 학습 주제 |
|---|---|---|
| 차체 블록 | 재료 무게 | 질량·무게중심, 같은 힘으로 밀 때의 차이 |
| 조종석 | 재료 무게 | 조종석 위치와 무게중심 |
| 무게추 | 재료 무게 | 낮은 무게중심과 균형 |
| 바퀴 | 크기·접지력·서스펜션 | 반지름 0.46/0.58/0.70m, 같은 축 토크에서 지면을 미는 힘, 미끄러짐과 스프링 반응 |
| 추진기 | 힘·장착 방향 | 실제 추력 252/360/468N, 힘의 방향과 회전 효과 |
| 자이로 | 힘의 세기 | 회전 제어·감쇠·조작 보조의 반응 |
| 날개 | 면적·장착 방향 | 면적·질량·양력·공기저항 |
| 기구 | 부력 | 161/230/299N의 위로 미는 힘과 전체 무게의 비교 |

타이어 고무, 금속 차축, 도장된 외장, 반투명 유리의 재질을 구분했습니다. 조종석에는 계기판과 핸들, 바퀴에는 안쪽 장착 브래킷·스프링·허브·트레드를 넣었습니다. 브래킷은 차체에 남고, 스프링은 서스펜션 길이를 따르며, 허브는 조향하고 타이어만 구릅니다. 다른 블록으로 가려진 조립 돌기는 숨깁니다.

## 에셋 폴더와 출처

프로젝트의 정식 보관 위치는 `C:\craftyap\assets\machines\block-kit-v2`입니다.

```text
block-kit-v2/
  source/     Blender 원본, 생성·정규화·학습 장면 스크립트
  runtime/    HQ·모바일 GLB, 원시 내보내기, SHA-256 manifest
  textures/   베이스 컬러·노멀·러프니스 원본
  previews/   Blender 렌더 이미지, 독립 실행 3D 검수 화면
  README_KO.md
  validation.json
```

게임 공개 URL은 기존 `apps/client/public/models/machines/`를 유지합니다. `assets/catalog.json`의 `machine-kit` 항목이 원본과 배포용 파일을 연결하고, 일치 여부를 검사합니다. 외부 모델을 가져온 것이 아니라 이번 작업에서 직접 만든 메시·UV·텍스처입니다. 기존 v1 생성기는 출처 기록용으로만 보관합니다.

## 재생성

Blender 5.4 Alpha(0d0b51704b28)로 제작했습니다. 아래 명령은 **새 백그라운드 Blender 프로세스**를 사용하며 열려 있는 작업 장면을 바꾸지 않습니다. 생성 스크립트를 다시 실행하면 이 폴더의 생성 결과를 덮어쓰므로 수동 편집한 원본은 별도 이름으로 보관해야 합니다.

프로젝트 루트의 PowerShell에서 `blender` 실행 경로를 지정한 뒤:

```powershell
$env:CRAFTYAP_VEHICLE_OUT = (Resolve-Path 'assets/machines/block-kit-v2').Path
$env:CRAFTYAP_REPO = (Get-Location).Path
& $blender --background --factory-startup --python-exit-code 1 --python assets/machines/block-kit-v2/source/build_machine_kit.py
node assets/machines/block-kit-v2/source/normalize_machine_kit.mjs $env:CRAFTYAP_VEHICLE_OUT
& $blender --background assets/machines/block-kit-v2/source/CraftYap_MachineKit_v2.blend --python-exit-code 1 --python assets/machines/block-kit-v2/source/render_learning_parts.py
pnpm assets:machines
pnpm assets:machines:check
node tools/check-asset-catalog.mjs
```

정규화 스크립트는 프로젝트의 Three.js, `sharp`, `@napi-rs/canvas`가 필요합니다. 후자 둘은 현재 Codex 런타임 의존성에서 읽습니다. 다른 컴퓨터에서는 설치된 `node_modules` 경로를 `CRAFTYAP_ASSET_MODULES`로 지정할 수 있습니다. CI의 `assets:machines`는 Blender 재실행 없이 이미 검수한 GLB를 동기화합니다.

## 검증과 범위

전체 클라이언트 검사 532개를 통과한 뒤, 추가한 회귀 검사를 포함한 자동차 전용 검사 22개가 통과했습니다. 타입 검사·수정 파일 린트·게임 프로덕션 빌드·에셋 검사도 수행했습니다. 자세한 결과와 해시는 `validation.json`에 기록합니다.

기존 설계도 버전 1과 기본 물리값은 유지합니다. 기존 공유 코드 `CYM1`도 읽으며, 부품 설정이 들어간 공유 코드는 `CYM2`를 사용합니다. 이전 버전 클라이언트는 `CYM2`를 읽을 수 없습니다.

검수 화면의 바퀴 동작은 연결 구조를 보여 주는 반복 시연이며 실제 운전 녹화가 아닙니다. 게임에는 실제 Rapier 질량·바퀴·추진력·공력 계산을 연결하고 검사했습니다. 이는 조립 학습용 근사 물리이며 실제 자동차 공학 수치의 예측 도구는 아닙니다. 현재 Work 설정에서 브라우저 자동화가 꺼져 있어 이번 마무리에서는 게임 화면을 직접 조작하는 검사를 수행하지 못했습니다. 온라인 배포는 하지 않았습니다.
