# 현재 게임의 1인칭 손과 소화기 잡기

현재 사용하는 파일만 보관한다. 둥근 손 덩어리, 작은 안쪽 엄지 표현, 두꺼운 손목과 짧은 팔을 사용한다. 노즐은 왼손 아래 안쪽에 닿으며 호스는 실제 연결 소켓에서 이어진다.

- `source/FirstPersonHands.blend`: 형태 키가 있는 양손 편집 원본.
- `source/ExtinguisherCarry.blend`: 승인한 잡기 배치를 실제 게임 좌표와 시야각으로 구성한 검토 장면.
- `first-person-hands.glb`: 양손 모델과 감싸기 형태 키·애니메이션.
- `preview.png`, `preview-detail.png`, `preview-portrait.png`: Blender 미리보기. 게임 화면 캡처는 아니다.
- `mesh-info.json`, `carry-placement.json`: 미터 단위 크기와 현재 배치 정보.

웹은 `apps/client/src/craft/fire/characterGrip*.json` 및 `fireCarryHands.ts`를 사용한다. 안드로이드는 `engine/assets/character-grip/model*.bin` 및 `fire_carry.rs`, `fire.rs`를 사용한다. 네이티브 바이너리 6개는 양손 각각의 펼침·중간·잡기 자세이므로 모두 필요하다.

메시 재생성:

    blender --background --python assets/characters/first-person/source/build_cotton_hands.py -- --repo C:/craftyap

생성기는 현재 이름의 원본·GLB·웹 데이터·네이티브 데이터를 갱신한다. 손의 화면 배치와 노즐의 왼손 아래 오프셋은 위 런타임 코드에서 관리한다.

검증은 `apps/client/test/fire-carry.test.ts`에서 캐릭터 어깨 연결, 몸통·손과 장비의 관통, 노즐 접촉, 가로·세로 화면 배치 및 웹·네이티브 데이터 일치를 확인한다.
