# CraftYap 에셋 관리

모델 원본과 게임 배포 파일은 구분합니다. 새 에셋은 `assets/catalog.json`에 등록하며, 참조 경로와 원본/배포 복사본을 `node tools/check-asset-catalog.mjs`로 확인합니다.

## 새 아이템의 기준 구조

```text
assets/items/tools/pickaxe-basic/
  item.json                  이름·버전·장착·타격·효율·옵션의 기준 데이터
  source/PickaxeBasic.blend   수정 가능한 Blender 원본, 텍스처 포함
  source/build_pickaxe.py     원본 형상을 다시 만드는 Blender 스크립트
  textures/                  512px albedo / normal / ORM, UV 구역 기록
  runtime/pickaxe-basic.glb   검수한 내보내기 파일
  previews/                  정면·측면·투명 아이콘·장착 검수
apps/client/public/models/items/tools/pickaxe-basic/
  pickaxe-basic.glb          게임이 로딩하는 동일한 GLB
  icon.png                  게임용 아이콘
```

식별자 `pickaxe-basic`은 유지하고 수정 이력은 item.json의 version으로 기록합니다. 최종본을 `final2`, `진짜최종` 같은 이름으로 늘리지 않습니다. work/ 파일과 검수 중간 GLB는 배포 경로에 넣지 않습니다.

## 기존 에셋

- HOME·TT: 게임 파일은 `apps/client/public/models/characters/{HOME,TT}/`에 유지합니다. 기존 편집 원본을 `assets/characters/home-tt/source/Characters.blend`로 보관했습니다. 이 원본은 보관용 참조이며, 재내보내기 전 현재 게임 GLB와 리그·얼굴·귀 동작을 대조해야 합니다.
- 블록: 실제 원본은 `src/craft/kitGeometry.ts`, `blockMaterials.ts` 등 코드입니다. 검수용 Blender 파일로 게임 형상을 덮어쓰지 않습니다.
- 생성 재질: `src/assets/block-materials-v3/`와 `generatedBlockTextures.ts`가 현재 연결 위치입니다.
- 기계: `tools/generate-machine-assets.mjs`와 `public/models/machines/manifest.json`으로 관리합니다.
- UI·음원: 현재 `public/home/`, `public/audio/` 경로를 목록에 등록했습니다. 모든 기존 파일을 새 이름으로 재배치한 상태는 아닙니다.

## 곡괭이 수정과 검수

1. source/PickaxeBasic.blend의 Editable source 컬렉션을 수정합니다. Generated runtime은 내보내기용, Preview studio는 검수 조명입니다.
2. UV 구역과 512px 맵을 유지합니다. ORM은 R=AO(현재 흰색), G=거칠기, B=금속성입니다. Normal은 OpenGL +Y입니다.
3. 단위 m, 게임 Y-up, 오른손 그립 Grip_Main이 원점입니다. Head_Center·Impact_Left·Impact_Right를 보존합니다.
4. 원본 파트를 평가해 하나의 메시·하나의 재질로 내보냅니다. 현재 2,540 triangles이며 텍스처는 GLB에 포함됩니다.
5. runtime/pickaxe-basic.glb를 게임 경로에 복사하고 해시 일치 검사, 장착·타격·해제 검사를 실행합니다.
6. item-preview.html에서 HOME·TT의 대기·채굴·걷기·기어가기를 확인합니다. 실제 게임은 /?mode=craft에서 E → 도구 → 핫바에 넣고 선택하면 장착됩니다. 왼쪽 클릭 공격, 길게 누르기 연속 공격·채굴, R 옵션입니다. H는 기존 조작법 메뉴입니다.

## 타격 설정과 범위

- 기본 사거리 2.4m, 정면 전체 각도 70°, 조준선의 첫 번째 고체 블록 한 개만 대상입니다. 벽 뒤 블록이나 주변 블록까지 함께 부수지 않습니다.
- 0.72초 주기, 58% 지점에서 채굴량을 적용합니다. 타격 판정은 조준 거리/각도를 사용합니다. 머리의 0.12m 구체는 검수와 향후 타격 이펙트용 표시이며, 실제 광역 충돌 판정이 아닙니다.
- 기본 재질 계수: 돌 1.6, 광석 1.7, 보석 1.25, 금속 1.1, 나무 0.8, 흙·모래 및 기타 1.0.
- 가벼운 손잡이: 스윙 속도 +15%, 타격당 작업량 -10%. 석재 집중: 스윙 속도 -10%, 돌·광석 작업량 +20%. 정밀한 날: 정면 각도 49°, 작업량 +5%.
- 사람 피해 0, 광역 파괴 꺼짐, 내구도 소모 꺼짐입니다. 교실의 기존 탭/밀기 서버 규칙은 곡괭이 능력으로 변경하지 않습니다. 교실에서는 검증된 장비·옵션·공격 위상을 서버가 중계합니다. 클라이언트와 서버 버전을 함께 배포해야 반영됩니다.

## 손 형태 보존

승인된 통통한 엄지 블록 손의 형상을 유지합니다. 손을 움직이는 upper_armR에 붙이고, 가중치가 없는 handR 본에 임의로 붙이지 않습니다. 팔뚝·손목 돌출이나 새 손가락을 추가하지 않습니다. 스윙은 손잡이를 손 안에서 따로 돌리지 않고 짧은 팔 전체로 움직이며, 어깨 캡 연결 제약을 마지막에 적용합니다. 눕기·기어가기·큰 제스처에서는 도구를 숨깁니다.

## 2026-10-30 · 그립과 타격 날

곡괭이 1.0.1은 기존 엄지 블록 손의 메시와 팔의 자연스러운 롤을 유지합니다. handR의 빈 본 중심에서 실제 엄지·손바닥 틈으로 그립을 옮겼습니다. `grip.bindOffset`은 bind-space 보정이며, `handleSlide`는 도구 로컬 단위로 0.035m(장착 배율 적용 후 약 2.5cm) 위로 올립니다.

장착 시 0.36초 동안 작은 additive lift를 더합니다. 팔의 절대 회전을 bind 자세로 덮어쓰지 않아 손이 반대로 뒤집히는 것을 막습니다. 옵션 변경은 장착 인스턴스를 유지합니다. 손잡이는 손의 두께 방향을 따라 바깥쪽 사선을 유지합니다. 머리만 손잡이 축 주위로 돌려 `swing.impactNode`인 Impact_Left가 캐릭터 정면(+Z)을 향하고, 타격 때 앞·아래로 내려오도록 맞췄습니다.

검수 화면의 주황 점은 타격 날 기준점, 초록 화살표는 캐릭터 정면입니다. 이 보조 표시는 검수용 모델에만 있습니다. 실제 채굴 대상은 기존 조준선·사거리·정면 각도 규칙을 사용하며, 구체 광역 충돌 판정으로 바꾸지 않았습니다. 바탕화면 re.png의 손잡이 사선을 참고했습니다.

최종 검사: 클라이언트 50개 파일·433개 테스트 통과, 타입 검사·변경 파일 린트·프로덕션 빌드 확인. HOME·TT, 두 회전 방향에서 타격 날의 정면 방향과 준비 대비 낮아지는 타격 궤적을 검사합니다.

## 2026-10-30 · 아이템 동작 기반 1.1.0

손과 도구를 함께 움직이는 보폭 흔들림, 가속/회전 관성, 공격 중 흔들림 억제, 중단 복귀를 추가했습니다. 조절값은 item.json의 grip.motion과 swing.phases/pitch/side에 모읍니다. 각 캐릭터의 승인된 Idle에서 그립 자세를 보관하며, 원본 손 메시나 곡괭이 형상은 변경하지 않습니다.

상세 설정·재사용 범위·검수 기록은 assets/items/tools/pickaxe-basic/ITEM_MOTION_FOUNDATION_KO.md, 검수 영상과 사진은 previews/motion-v3/에 보관합니다. 전체 438개 테스트와 타입·린트·빌드, 별도 item-preview 번들을 확인했습니다. 실시간 브라우저 동작 검수는 별도 확인이 필요합니다.

## 2026-10-30 · 전방 타격 1.1.2

타격 날의 정면 방향과 별도로 실제 이동 속도를 확인하도록 검증을 보강했습니다. 타격 58% 시점이 날의 전진·하강 구간에 오도록 공격 궤적을 수정하고 0.72초 주기에 맞췄습니다. swing.lean으로 상체의 작은 무게이동을 더하되 발과 루트는 고정합니다. 상세 내용과 441개 검사 결과는 previews/forward-strike/의 CHANGES_KO.md와 validation.json에 기록했습니다.

## 2026-10-30 · 실제 아이템 등록 1.2.0

곡괭이를 가방의 도구 아이템으로 등록했습니다. 실제 보유 수량과 선택한 핫바 슬롯으로 장착/공격 모드를 결정하며, 일반 URL에서 동작합니다. 기본 1개, 최대 수량 1개이며 기존 핫바는 보존합니다. 공격 입력은 itemAttack.ts의 시계를 공유해 단발 클릭/홀드와 실제 채굴 타격을 일치시킵니다. 세부 반영 내용은 assets/items/tools/pickaxe-basic/ITEM_REGISTRATION_KO.md, 검수 결과는 previews/registered-item/에 보관합니다. 최종 575개 테스트와 타입·린트·클라이언트/서버 빌드를 통과했습니다.

## 2026-10-30 · 곡괭이 동작 다듬기 1.2.1

중간 키에서 멈추는 보간을 연속 Hermite 곡선으로 교체하고, swing.roll/twist로 작은 팔·상체 기울기를 연결했습니다. 실제 그립·공격 판정·저장 구조는 유지합니다. 전체 클라이언트 461개 검사와 타입·린트·빌드 통과. 상세 변경과 5개 시점 비교는 assets/items/tools/pickaxe-basic/previews/motion-polish/에 보관합니다. 실시간 브라우저 조작 검수와 배포는 완료하지 않았습니다.

## 2026-10-30 · 곡괭이 디테일 점검 1.2.3

그립·공격 곡선을 유지하고 0.18초 장착 해제 복귀, 한 번의 후속 클릭 버퍼, 투명 도구의 깊이/그림자/잉크 제어, 물통 전용 물 뜨기 분기를 보강했습니다. 전체 클라이언트 467개 검사와 타입·린트·작업 폴더 출력 빌드 통과. 검증과 미디어 출처는 assets/items/tools/pickaxe-basic/previews/detail-audit/에 보관합니다. 홈페이지 업데이트 원고는 notes/patch-2026-10-30.md의 배포 전 초안입니다.
