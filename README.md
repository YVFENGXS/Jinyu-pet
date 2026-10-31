# 金羽桌宠客户端（rp-desktop-pet）

`jinyu-memory` 的桌面端薄客户端：只负责渲染、输入采集和本地闲时状态机。记忆召回、披露判定、LLM、提醒与租约全部留在服务器。

- 服务端仓库：<https://github.com/YVFENGXS/Jinyu-memory>
- 协议真源：`jinyu-memory/docs/protocol/desktop-v1.md`
- 当前状态：**初始化阶段**，仅仓库骨架与协议钉版，尚无客户端代码

## 边界

- 不接收、不缓存、不落库任何记忆卡或召回结果；下行只有最终文本、情绪标签与动作意图
- 不保存对话历史，离线只保留动画资源与少量本地台词
- 不主动连接服务器之外的地址；所有网络请求走同一出口
- 服务器永远不会主动拨入本机，连接一律由客户端出站发起

## 技术栈

未锁定。候选：

1. **Wails v2 + WebView2**（优先验证）：体积小、透明 WebM 直接由 `<video>` 播放、窗口 Region 可控
2. **Electron**：跨平台与 rig 渲染能力强，但体积和内存开销大

选型以 MVP 闭环跑通为准，选型结论回写到本文件。

## 计划结构

```
rp-desktop-pet/
├── app/            # 窗口外壳、托盘、自动更新
├── renderer/       # 气泡、动画调度、穿透命中
├── protocol/       # 协议版本钉版（不存正文）
├── assets/         # 动画包与形象包，走 Release，不进 git
├── tests/          # 协议样例回放与窗口行为测试
└── THIRD-PARTY-NOTICE.md
```

## 协议

- 版本：`desktop-v1`
- 客户端在 `hello` 中声明 `capabilities`，服务端据此降级
- 协议变更流程：服务端仓库改正文与 fixtures → 客户端升级并更新 `protocol/VERSION`
- 不得在本仓库复制协议正文，避免两份不一致

## 资产与许可

动画与形象素材不进入 git 历史，通过 Release 附件分发；来源与许可见 [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)。

若后续引入 AGPL 代码，本仓库需整体切换为 AGPL-3.0，并与服务端仓库保持许可隔离。
