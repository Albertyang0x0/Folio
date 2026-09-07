# 阅屿 · Folio 品牌资源

## 冰川 Logo

`yueyu-glacier.png` 是用户选定的纯冰川 Logo 的独立应用图标，用于论文库、阅读顶栏、浏览器标签和触屏书签；不含概念稿上的字标及底部变体。字标在 HTML 中以真实文字呈现，窄屏可收起，仍保留无障碍名称。资源随应用提供，不依赖生成服务或在线图片地址。

制作方式：内置 image_gen 工具，以上一版已确认的冰川概念稿为输入，提取主图标；没有使用 CLI/API 备用路径。现有 EXE 未重新构建，Windows 可执行文件图标不在此次网页品牌接入范围内。

### 独立图标生成提示词（原文）

Use case: background-extraction / identity-preserve.
Input image: the user-approved glacier logo brand board, edit target.
Create ONE production app-icon asset from the LARGE TOP ICON ONLY. Preserve that exact glacier symbol and its existing proportions: the taller left ice peak, shorter right peak, blue geometric facets and the narrow bright crevasse. Preserve its pale ice-blue rounded-square frosted-glass tile and fine blue-white border. Do not redesign, rotate or add any detail.
Remove every Chinese and English wordmark, all small bottom sample icons, and the surrounding presentation backdrop. Isolate just the main rounded-square app icon on a genuinely TRANSPARENT background with alpha outside the rounded corners. Do not paint a checkerboard. Trim empty margins so the outer tile occupies 94% of the square canvas width and height, centered, with a tiny transparent safety margin. Keep its glass material visible inside the tile, but no broad external glow or large drop shadow. Output a single clean, sharp, square high-resolution PNG icon, front view, no text, no extra objects, no collage. This is asset preparation for the approved design, not a new concept.

## 冰川玻璃背景

`glacier-wallpaper.png` 是随应用提供的本地背景，由内置图像生成工具生成；运行时无需联网，也不包含界面文字。CSS 负责玻璃材质、亮度遮罩和状态颜色，PDF 页面本身不使用滤镜。图片未加载时使用淡蓝灰底色。

### 背景生成提示词（原文）

Use case: photorealistic-natural. Asset type: local desktop app background wallpaper, landscape 16:10 at 1920x1200 or similar. Create an understated luminous glacier landscape designed to sit behind a frosted-glass academic reading app. Very pale silver-blue fog fills the top two thirds and center as clean quiet negative space. Small snow-covered mountain slopes frame only the lower far left and lower far right edges, receding into mist; a calm glacial lake fades into the bottom center. Sophisticated macOS-like natural wallpaper, low contrast, airy diffused daylight, subtle tactile snow and ice detail at the edges. Colors: pearl white, fog gray, desaturated ice blue and slate; no purple, no green, no warm sunset. No dramatic peaks in the middle, no bold horizon, no bright sun disc, no aurora, no buildings, no people, no text, no UI, no windows, no glass panels, no icons, no watermark. Functional muted background for long reading sessions; image itself must be clean without baked-in overlay or UI.
