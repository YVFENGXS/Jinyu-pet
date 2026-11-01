# 第三方素材与参考项目

## Coopanion 大肥鱼（已引入，AGPL-3.0）

`prototype-webview/web/vendor/coopanion/` 下的以下内容逐字复制自
`Pal-AI-Lab/Coopanion`（`packages/cortico-world-desktop-pet/web/`）：

- `whale/`（`figure.js`、`figure.json`、`model.json`、`tex/`、`feat/`、`schemes/`、`outfits/`、`thumbs/`）
- `kit/body.js`、`kit/rig.js`
- `sound.js`

上游采用 **GNU AGPL-3.0-or-later**，并附有 AGPL 第 7 条的 Steamworks 链接附加许可；完整文本见本仓库 [LICENSE](LICENSE)。本仓库整体据此切换为 AGPL-3.0。

形象署名（来自 `whale/figure.json`）：

- 角色原设：**溟月(上善无形)**
- DeepSeek 女仆二创：**ZipZipPipe**
- 形象包作者：**Pal-AI-Lab**

本项目的改动：将 `whale/` 与 `kit/` 保持同级以保证 `figure.js` 的动态 `import('../kit/rig.js')` 可用；页面用自己的 `app.js` 驱动 `createBody`，追加了透明窗口点击穿透、输入胶囊、菜单与配色切换、页面内拖拽、跨显示器跟随，以及把桌面文件拖入喂食并移入回收站的宿主逻辑。

对 Coopanion 源文件的唯一改动是 `kit/body.js` 的泪滴粒子：把 `DROP` 的绘制缩放从 `0.9*sc` 降到 `0.45*sc`，并加一条淡蓝描边和一处高光椭圆（`.tear-hl`），使小尺寸下仍能看清。`whale/` 下的形象资源与其余 `kit/` 逻辑未改动。

## Electron（MIT，运行时依赖）

`prototype/` 的透明宿主由 Electron 运行（`electron` 为 devDependency，不复制其源码进本仓库）。Electron 的 MIT 许可文本随依赖位于 `prototype/node_modules/electron/LICENSE`；分发安装包时需一并附带其许可与 Chromium 的第三方声明。

### 商标说明

页面配色方案中出现的 DeepSeek、ChatGPT、Claude、Gemini、千问、Kimi、MiniMax 等名称与标志，仅用于粉丝二创与换色演示；本项目与上述厂商无隶属或授权关系。

## 其他参考实现（未复制代码）

- `Pal-AI-Lab/Coopanion`：参考其桌面宠物宿主的工作区透明窗口、鼠标租约与跨屏 `followCursor` 设计；未复制其宿主代码。
- `Bai-Cute/big-blue-fish-desktop-pet`：仅参考 WPF 分层窗口的像素级命中与解码残留清理思路。
- `shenliuyu18/dafeiyu-pet`：仅参考 Wails + WebView2 + 窗口 Region 的穿透方案。
- 早期候选的透明 WebM 动画包（`PC2005-cloud/dsh-pet` 等）未采用、未复制。

## 服务端

- `YVFENGXS/Jinyv-memory`（MIT）：协议真源与记忆核心所在仓库，与本客户端仅经网络协议交互，保持许可隔离。
