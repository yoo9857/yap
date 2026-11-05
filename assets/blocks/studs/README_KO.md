# CraftYap 블록 돌기 (Blender 원본)

2026-11-05. 블록 윗면의 돌기 4개(2×2)는 Blender에서 만든 에셋입니다. 웹 게임(three.js)과 네이티브 앱(Rust/wgpu)이 **같은 GLB 한 벌**을 읽습니다. 섬 지형·성·직접 놓은 블록 모두 이 돌기를 씁니다.

## 출처

승인된 소프트 블록 형태(`CraftYap_soft_block_form`, 2026-10-29)의 `BlockForm.blend`에서 최종 블록 "Soft continuous shell and low closed connectors"의 돌기만 떼어 냈습니다. 원본 파일 이름과 SHA-256은 `runtime/manifest.json`의 `liftedFrom`에 기록합니다. 원본은 8 MB(파편·카드·텍스처 포함)라 저장소에 넣지 않았고, 돌기만 담은 `source/BlockStuds.blend`가 이후의 편집 원본입니다.

## 메시 2개 (최적화)

| 메시 | 삼각형 | 쓰는 거리 | 형태 |
|---|---|---|---|
| `Stud_HQ` | 568 | 초점에서 12 m 안 | 원본 그대로. 16각, 5단 프로파일(높이 0/0.4/3/3.7/4 cm, 반지름 9.8/10/10/9.4/8.6 cm) |
| `Stud_LOD1` | 152 | 12–32 m | 같은 치수와 윤곽. 1 cm 미만의 베벨 링 2개를 빼고 8각 |

- 12 m에서 베벨 링은 1 px 미만이고, 지름 20 cm 돌기의 8각형은 원과 약 0.6 px 차이가 납니다. 그래서 눈에 보이는 차이 없이 비용만 줄어듭니다.
- 아랫면 뚜껑은 블록 윗면에 묻혀 보이지 않으므로 없습니다. 윗면과 베벨 사이 모서리만 각지게, 옆면은 부드럽게 음영 처리합니다.
- 기준점은 블록 윗면 중앙, 단위 m, GLB는 +Y 위입니다. 재질·색이 없으며 블록의 색과 표면을 그대로 받습니다.
- 32 m 밖에는 돌기를 그리지 않습니다(이전과 같음).

## 다시 만들기

```powershell
# 편집 원본에서 다시 내보내기(손으로 고친 내용 유지)
& $blender --background --factory-startup --python-exit-code 1 --python assets/blocks/studs/source/build_block_studs.py -- assets/blocks/studs/source/BlockStuds.blend assets/blocks/studs
Copy-Item assets/blocks/studs/runtime/block-studs.glb apps/client/public/models/blocks/block-studs.glb
node tools/check-asset-catalog.mjs
cd apps/client; npx vitest run test/block-studs.test.ts
```

`BlockForm.blend`를 입력으로 주면 돌기를 처음부터 다시 떼어 내 `BlockStuds.blend`를 새로 만듭니다. 같은 입력에서는 같은 GLB가 바이트 단위로 똑같이 나옵니다.

GLB를 바꾸면 `apps/client/src/craft/blockStuds.ts`의 `BLOCK_STUDS_URL` 버전(`?v=`)을 올리세요. 브라우저 캐시 때문입니다. 네이티브 앱은 빌드할 때 GLB를 포함하므로 다시 빌드해야 합니다.

## 검사

- `apps/client/test/block-studs.test.ts`: 게임이 쓰는 GLB가 내보낸 GLB·manifest 해시와 같은지, `Stud_HQ`가 코드 쌍둥이(`kitConnectorGeometry`)와 모든 점이 같은지, `Stud_LOD1`이 같은 범위·높이를 지키는지 확인합니다.
- `engine/crates/client`의 `studs` 테스트: 네이티브 앱이 같은 GLB를 읽어 같은 삼각형 수를 얻는지 확인합니다.
- `node tools/check-asset-catalog.mjs`: 원본과 배포 파일이 같은지 확인합니다.

GLB를 불러오지 못하면 웹은 코드 쌍둥이(`kitConnectorGeometry`, 원본과 같은 형상)로 그립니다. 모양은 같고 먼 거리 비용만 늘어납니다.
