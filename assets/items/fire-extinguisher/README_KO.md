# CraftYap 소화기 1.3.1

일반 축압식 ABC 소화기를 바탕으로 만든 교육용 게임 모델입니다. 높이는 약 0.54m이고 GLB는 Y-up입니다.

밸브 옆 출구, 연결 너트, 호스 보호 슬리브와 호스 시작부가 같은 축에 놓입니다. 호스 양 끝은 Blender 원본과 게임에서 같은 장착점과 방향을 사용합니다. Nozzle_Tip은 분사의 시작점입니다.

SafetyPin_Mount에 핀의 설치 위치를 저장합니다. 자식 SafetyPin에는 Pin_Pull 애니메이션을 넣어 GLB에서 애니메이션을 재생하기 전에도 고리가 손잡이 옆에 보입니다. Lever_Squeeze 클립과 Grip_Main 부착점도 포함합니다.

4단계에서 레버와 노즐을 한 화면에 유지합니다. 누르기를 마치고 다음 버튼을 선택하면 좌우 분사 단계로 이동합니다. 분말은 분사 당시의 위치와 방향을 따라 퍼지고, 레버에서 손을 뗀 뒤 천천히 가라앉습니다.

현재 편집 원본은 `CraftYap_Extinguisher.blend`, FBX 내보내기는 `extinguisher.fbx`입니다. 게임의 GLB는 `apps/client/public/models/items/fire/extinguisher/extinguisher.glb`에 있습니다.

같은 폴더의 `verify_extinguisher_geometry.py`를 저장된 .blend에 실행하면 밸브 부품의 겹침과 호스 양 끝의 위치 및 방향을 검사합니다. `build_extinguisher.py`는 이 폴더의 편집 원본·내보내기 파일과 웹·네이티브 데이터를 갱신합니다.

형태 참고 [Amerex 부품 도해](https://amerex-fire.com/upl/downloads/content-blocks/fire-extinguisher-parts-book.pdf#page=5)

사용법 참고 [행정안전부 안전한TV](https://www.safetv.go.kr/base/video/view?idx=23)
