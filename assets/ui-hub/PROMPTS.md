# 홈 허브 UI 에셋 — ChatGPT 이미지 프롬프트

자동 생성: `node assets/ui-hub/generate.mjs` (Codex CLI의 이미지 생성, ChatGPT 로그인 사용).
스크립트의 프롬프트·크기(1024×1024 / 1536×1024 / 1024×1536)가 기준이고, 이 문서는 사람이 읽는 사본입니다.
ChatGPT에서 직접 만들 때도 PNG는 `assets/ui-hub/raw/`에 **아래 파일 이름 그대로** 넣어 주세요.
Claude가 잘라서(9-slice) 웹용 WebP로 바꾸고 `apps/client/public/ui/hub/`에 넣어 홈 화면에 적용합니다.

## 공통 규칙 (모든 프롬프트 앞에 붙여 주세요)

```
Game UI asset for a cute kids' voxel building game called CraftYap.
Style: chunky glossy toy-building-brick plastic (studs on top, rounded edges, soft studio light),
mixed with a playful crayon-doodle look: every shape has a thick dark ink outline (#1f1f1f, ~6px at 1024px).
Palette: sunny yellow #ffd21c, sky blue #2f7de1, grass green #52b84d, warm wood #cf9152, cream #fff7e0, red accent #ef3a5d.
Flat FRONT view, no perspective, no tilt, centred, perfectly symmetrical left/right.
TRANSPARENT background (PNG with alpha). No text, no letters, no logos, no watermark.
```

## 프레임 (9-slice용 — 가운데는 비우고, 테두리 두께는 사방이 같게)

| 파일 이름 | 크기 | 프롬프트 (공통 규칙 뒤에) |
|---|---|---|
| `panel-frame.png` | 1024×1024 | A square UI panel frame made of toy bricks: a cream rounded-rectangle board with a yellow brick rim and small studs along the top edge, decorated corners (a tiny brick cluster in each corner). The INSIDE is completely empty transparent. Rim thickness exactly the same on all four sides, about 10% of the width. The straight edges between corners are plain and repeatable. |
| `panel-frame-blue.png` | 1024×1024 | Same as panel-frame but the rim is sky blue bricks with white studs. |
| `card-frame.png` | 768×1024 | A portrait card frame: thick white glossy brick rim with ink outline, rounded corners, studs only on the top edge. Inside fully transparent. Even rim thickness (~7%). |
| `card-frame-gold.png` | 768×1024 | Same card frame but golden yellow glossy bricks with tiny sparkle stars on the corners — the "selected" card. |
| `bar-frame.png` | 1536×384 | A wide horizontal toolbar frame: dark navy translucent-looking glass panel with a yellow brick rim, studs along the top, rounded ends. Inside transparent. Even rim thickness. |
| `title-plaque.png` | 1024×256 | A small horizontal title plaque: yellow brick bar with studs on top and two little nails on the ends, inside plain yellow (for text to be written on later). |

## 버튼

| 파일 이름 | 크기 | 프롬프트 |
|---|---|---|
| `start-button.png` | 1536×384 | A huge pill-shaped "start" button made of a single glossy sunny-yellow toy brick, long and wide, with a row of studs on top, darker orange bottom edge to look pressable, a white glossy highlight along the top. Plain face (no text, no icon). |
| `start-button-pressed.png` | 1536×384 | The same button pressed down: the bottom edge almost gone, slightly darker. |
| `tab-active.png` | 512×256 | A small rounded tab button: white glossy brick with ink outline and a blue underline brick. Plain face. |

## 아이콘 (한 장에 하나, 512×512, 투명 배경, 같은 조명·같은 두께로)

공통으로 덧붙이기: `A single game icon, centred, filling ~80% of the canvas, chunky 3D toy-brick style, thick ink outline, transparent background.`

| 파일 이름 | 아이콘 |
|---|---|
| `icon-home.png` | a little toy-brick house with a red roof |
| `icon-map.png` | a folded treasure map with a red pin |
| `icon-create.png` | a crossed hammer and wrench made of bricks |
| `icon-community.png` | two speech bubbles, blue and yellow |
| `icon-bell.png` | a golden bell |
| `icon-mail.png` | a white envelope with a red heart seal |
| `icon-friends.png` | two cute block-head characters side by side |
| `icon-settings.png` | a chunky blue gear |
| `icon-bag.png` | a brown adventure backpack |
| `icon-shop.png` | a little shop stall with a striped awning |
| `icon-character.png` | a cute white bunny block character head |
| `icon-gallery.png` | a picture frame showing a tiny voxel island |
| `icon-party.png` | a party popper with confetti |
| `icon-trophy.png` | a golden trophy cup |
| `icon-guide.png` | an open storybook |
| `icon-lock.png` | a small padlock (for "coming soon") |
| `icon-coin.png` | a gold coin with a star |
| `icon-gem.png` | a blue crystal gem |
| `icon-calendar.png` | a desk calendar with a green check |
| `icon-gift.png` | a gift box with a red ribbon |
| `icon-grad.png` | a graduation cap (education mode) |
| `icon-crown.png` | a golden crown (game mode) |

## 배지 / 장식

| 파일 이름 | 크기 | 프롬프트 |
|---|---|---|
| `badge-soon.png` | 512×192 | A small rounded "coming soon" badge: yellow brick pill with a tiny padlock on the left, plain face for text. |
| `ribbon-corner.png` | 512×512 | A diagonal corner ribbon (top-right corner of a card), yellow with ink outline, plain face. |
| `avatar-frame.png` | 512×512 | A square avatar frame of golden bricks with studs on top and a small star at the bottom; inside transparent. |
| `deco-bricks.png` | 1024×512 | A loose pile of 6–8 colourful toy bricks and two little flowers, to decorate the corner of a panel. |

## 확인할 것
- 배경이 진짜 투명인지 (회색 체크무늬가 그려진 이미지면 안 됩니다).
- 글자가 들어가지 않았는지 (글자는 화면에서 따로 씁니다).
- 프레임의 가운데가 비어 있고, 테두리 두께가 사방이 같은지.
