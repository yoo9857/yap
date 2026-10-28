# Sunny Village animated menu background

The approved animation is a 15-second, 24fps Sunny Village loop. Grok CLI
`reference_to_video` generated the character/environment animation from the
original Sunny Village image. FFmpeg normalized timing and removed audio;
localized OpenCV deformation added periodic breeze to foliage and flowers.
The source is native 1280×720; no upscale is used.

`public/backgrounds/craftyap-sunny-village-alive-v1-*` contains desktop 720p
and mobile 854×480 variants in VP9/WebM and H.264/MP4. All four have 360
frames and no audio. WebM is preferred when supported; MP4 is the fallback.
The mobile variant is selected below 768px width or at 480px height and below.

The mode picker, classroom lobby and boot overlay share one video element.
Static Sunny Village images remain visible until playback starts, when
autoplay is blocked, on media errors, with reduced motion, or with data saver.
The pause control remembers the visitor's choice. Hidden tabs pause immediately;
gameplay releases the video source and decoder. The server supports HEAD and
single byte ranges for video seeking and looping.

Validation: full decoding and 15-second/360-frame/no-audio checks for each
variant; HTTP MIME/range smoke checks; browser tests for responsive selection,
looping, pause persistence, classroom continuity, preference changes, media
failures, autoplay denial, and releasing video after entering actual gameplay.
