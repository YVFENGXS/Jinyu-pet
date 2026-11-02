# 瑾瑜桌宠客户端（Jinyu-pet）

瑾瑜的桌面端薄客户端：只负责渲染、输入采集和本地闲时状态机。记忆召回、披露判定、LLM、提醒与租约全部留在服务器。

- 服务端仓库：<https://github.com/YVFENGXS/Jinyv-memory>
- 协议真源：`Jinyv-memory/docs/protocol/desktop-v1.md`
- 当前状态：**原型试运行**，已跑通当前显示器工作区的透明覆盖、点击穿透、页面内拖拽、跨显示器拖拽跟随、拖入文件喂食，并已接入服务端的 desktop-v1 AI（离线时回退到本地假回复）

## 现有原型

当前版本是 `prototype/` 的 **Electron 透明宿主**，页面与形象共用 `prototype-webview/web/`：

- 窗口覆盖当前显示器的工作区，透明置顶；Electron 的 `setIgnoreMouseEvents` 按页面命中结果切换点击穿透
- 形象与动作来自 `Pal-AI-Lab/Coopanion` 的「DeepSeek 大肥鱼」鲸鱼娘（WebGL rig + SVG）
- 拖拽在页面内完成，窗口不跟着光标搬动；光标位置由宿主每 16ms 上报，鲸鱼始终跟手
- 拖到另一块显示器时，窗口会移到该显示器的工作区，并把拖拽位置换算到新窗口（Coopanion 的 followCursor 思路）
- `Ctrl+Alt+J` 隐藏/召回；右键鲸鱼打开菜单（换配色、聊天记录、连接/断开服务器、静音勿扰、隐藏、退出）
- 悬停鲸鱼出现提示按钮，输入胶囊贴着鲸鱼头顶；连上服务器时回复来自瑾瑜的真实模型，连不上时用本地关键词假回复
- 把桌面快捷方式、文件或文件夹拖到鲸鱼身上即可喂食：宿主用 `shell.trashItem` 移入系统回收站（可恢复）；喂食时鲸鱼会端出饭碗和木勺扒饭约 2 秒，喂失败会露出带小泪滴的难过表情
- 空闲动作使用 `roam: 'calm'`，降低换动作的频率

运行（Electron 已装在 `prototype/node_modules`）：

```powershell
cd Jinyu-pet\prototype
npm start
```

如果当前盘上的 `electron.exe` 被执行策略拦截，可双击 `prototype\start.cmd`。它会优先使用 C: 上已复制的 Electron 运行时（`%USERPROFILE%\.local\share\rp-pet-electron\electron\electron.exe`），再回退到 `node_modules`；也可以把 `electron.exe` 加入安全软件/应用控制白名单后直接 `npm start`。

### 接入服务器 AI

双击 `prototype\start-ai.cmd`：客户端带 `--desktop-url=ws://127.0.0.1:8787/desktop/v1/ws` 启动；宿主发现本机 8787 没人监听时，用部署密钥在后台拉起一条隐藏的 SSH 隧道（`windowsHide`，不弹黑窗口），退出桌宠时一并关掉。回复由服务器的瑾瑜模型生成，落库与记忆留在服务器；记忆默认接入 QQ 主私聊的同一条会话，和 QQ 端共享上下文与长期事实。隧道断开时客户端自动重连，宿主 25s 无响应则回退本地假回复。右键菜单里的「连接服务器 / 断开服务器」就是总开关：开着时点一下会断开并停掉隧道，关着时点一下会拉起隧道并连上。

- 服务端安装与密钥说明见 `Jinyv-memory` 的 README（`deploy/install_desktop_adapter.sh`，systemd 服务 `rp-desktop`，默认只监听回环）
- 健康检查：`curl http://127.0.0.1:8787/desktop/v1/health` → `{"ok":true,"mode":"real"}`
- 隧道的主机与密钥不进仓库，由本机私有配置提供：`%USERPROFILE%\.rp-pet\config.json` 里写 `{"tunnelHost":"ubuntu@<你的主机>","deployKey":"<私钥路径>"}`，密钥文件也可直接放 `%USERPROFILE%\.rp-pet\deploy_key`；`RP_TUNNEL_HOST` / `RP_DEPLOY_KEY` 环境变量优先级更高。缺任一项时宿主跳过隧道，只在本地回复
- 不想联网时照旧用 `start.cmd` 或 `npm start`，只走本地假回复；也能在菜单里断开服务器，或手动带 `--desktop-url=` / `--desktop-token=` 连别的 desktop-v1 服务
- 上下文另外在本地留了一份：桌宠里的「我」和「瑾瑜」说话会写进 `%APPDATA%\rp-desktop-pet-prototype\chat-history.jsonl`（每行一条 JSON，超过 256 KB 自动压成最近 400 条）。右键菜单的「聊天记录」会按日期列出最近的对话并显示这个文件路径，关掉桌宠再打开也还在；服务器那边则继续用 QQ 主私聊的同一条会话来记得完整上下文

`prototype-webview/` 是保留的 **WPF + WebView2** 版本（透明合成路径更重；本地聊天记录只在 Electron 宿主里落盘）：

```powershell
dotnet build -c Release
dotnet bin\Release\net8.0-windows10.0.19041.0\RpPetWebView.dll
```

页面在 Electron 下由本地 HTTP 服务提供，在 WPF 下由虚拟主机 `https://pet.local` 提供。窗口一次覆盖一个显示器的工作区；宠物可以拖到另一块屏，但不会自行在两块屏之间长距离走。

## 边界

- 不接收、不缓存、不落库任何记忆卡或召回结果；下行只有最终文本、情绪标签与动作意图
- 不保存对话历史，离线只保留动画资源与少量本地台词
- 不主动连接服务器之外的地址；所有网络请求走同一出口
- 服务器永远不会主动拨入本机，连接一律由客户端出站发起
- WebGL 形象与透明窗口依赖本机显卡/WebView2，暂只支持 Windows 与主显示器
- 喂食会把拖入的快捷方式、文件、文件夹移入回收站；不提供永久删除，也不接受盘符根、用户目录等系统路径

## 目录

```
Jinyu-pet/
├── prototype/           # 当前主宿主：Electron 透明窗口
│   ├── main.js          # 窗口、点击穿透租约、光标上报、跨屏跟随、喂食回收
│   ├── preload.js       # 页面桥与文件路径
│   ├── start.cmd        # 离线运行（本地假回复；Electron 被策略拦截时用备用运行时）
│   └── start-ai.cmd     # 连服务器 AI（隧道由宿主自己拉起，菜单里可开关）
├── prototype-webview/   # 共用的页面/形象资产 + WPF 备用宿主
│   ├── web/             # 页面、样式、大肥鱼资产（vendor/coopanion）
│   └── MainWindow.xaml.cs
├── prototype-wpf/       # 早期 WPF 原型（命中/拖拽思路参考）
├── docs/                # 方案与调研
├── protocol/            # 协议版本钉版（不存正文）
├── LICENSE              # AGPL-3.0
└── THIRD-PARTY-NOTICE.md
```

## 协议

- 版本：`desktop-v1`
- 客户端在 `hello` 中声明 `capabilities`，服务端据此降级
- 协议变更流程：服务端仓库改正文与 fixtures → 客户端升级并更新 `protocol/VERSION`
- 不得在本仓库复制协议正文，避免两份不一致

## 致谢

- **`Pal-AI-Lab/Coopanion`** —— 形象资产、透明宿主与 `followCursor` 跨屏跟随思路（AGPL-3.0，详见 [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)）。
- **`Bai-Cute/big-blue-fish-desktop-pet`**、**`shenliuyu18/dafeiyu-pet`** —— WPF / Wails 透明窗口与像素级命中思路参考，未复制代码。
- **`YVFENGXS/Jinyv-memory`** —— 记忆核心、`desktop-v1` 协议与服务端 AI（MIT）。
- **Electron** —— 透明窗口运行时（MIT）。

完整的第三方素材、许可与署名见 [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)。

## 许可

本仓库因引入 `Pal-AI-Lab/Coopanion` 的代码与形象资产，整体采用 **GNU AGPL-3.0-or-later**（含 Coopanion 的 section 7 附加许可），见 [LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)。

`jinyu-memory` 服务端保持 MIT：两者为独立进程，仅通过版本化协议经网络交互，不构成同一程序。分发本客户端的修改版时，须按 AGPL 提供完整对应源码。
