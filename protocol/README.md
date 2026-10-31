# 协议钉版

本仓库**不保存协议正文**，唯一真源在服务端仓库：

<https://github.com/YVFENGXS/Jinyu-memory/blob/main/docs/protocol/desktop-v1.md>

当前锁定版本：见 `VERSION`（`desktop-v1`）。

约定：

- 只做加法时，客户端必须忽略未知 `type` 与未知字段
- 破坏性变更由服务端开 `desktop-v2` 端点，客户端按 `protocol` 字段判断
- 客户端能力位需与实现一致，不得声明未实现的能力

样例报文（用于本地回放测试）：

<https://github.com/YVFENGXS/Jinyu-memory/tree/main/tests/protocol_fixtures>
