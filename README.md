# Pocket Phone 小手机（st-pocket-phone）

SillyTavern 第三方 UI 扩展：角色绑定短信、全屏 H5 聊天、预设隔离、多气泡协议、记忆压缩与思维链展示。

## 安装

扩展 → 安装扩展 → 粘贴：

```text
https://github.com/vpocket-99/st-pocket-phone
```

或 symlink 到 `SillyTavern/public/scripts/extensions/third-party/st-pocket-phone/`。

## 怎么用

1. 进入角色对话（也可先打开小手机，从最近列表选角色）。
2. 点输入框左侧 **汉堡菜单 →「小手机」**（或扩展设置里的入口）。
3. **最近列表**：置顶 / 备注 / 从列表移除（记录仍保留）。
4. **短信**：`发送气泡` 可连发；`请求回复` 才调用模型。长按气泡可编辑 / 删除 / 重 roll。
5. **预设**：选用短信专用预设（与主聊天预设隔离）；可编辑 PromptManager 条目。
6. **更多**：多语言、头像、背景、记忆、语音、API 收藏等。

## 主要能力

| 模块 | 说明 |
|------|------|
| 预设隔离 | 进入小手机切到专用预设，离开还原主聊天预设 |
| 多气泡协议 | 解析 `<msg>` / `<voice>`，流式逐条出泡 |
| 风格 / 格式条目 | 可强制写入「📱风格化」「Output Format Instructions」等 |
| 多语言 | 按角色语言注入；气泡内原文+翻译 |
| 思维链 | 有 reasoning / `<think>` 等时，气泡左上角可展开思考过程 |
| 记忆 | 超阈值压缩；关闭时可自动导入主聊天（`<phone>` 包裹） |
| 主聊天对齐 | 线程与当前 `chat_id` 绑定；新开主聊天对应新短信线程 |

## 输出协议（模型侧）

参考仓库内 `default-preset.txt`，以及提示词工程里的风格条目。模型应主要输出：

```xml
<msg>第一条</msg>
<msg>第二条</msg>
```

可选语音气泡：`<voice>...</voice>`。思维过程可用 `<think>...</think>` 或 API 的 `reasoning_content`（不会进短信正文）。

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。当前 `manifest.json` 版本以安装后的扩展信息为准。

## 许可

MIT
