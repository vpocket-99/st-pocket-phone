# Pocket Phone 小手机（st-pocket-phone）

SillyTavern（酒馆）第三方 UI 扩展：悬浮拟真手机壳 + 短信 App。复杂交互在独立浮层完成，**不向聊天气泡注入 iframe / 复杂 HTML**。

## 安装

### 用 GitHub 链接（推荐）

1. 确认本机已安装 [git](https://git-scm.com/)。
2. 打开酒馆 → **扩展** → **安装扩展**。
3. 粘贴：

```text
https://github.com/vpocket-99/st-pocket-phone
```

4. 安装完成后刷新页面，在扩展管理中启用 **Pocket Phone 小手机**。

### 本地开发 / 手动安装

将本仓库放到（或 symlink 到）：

```text
SillyTavern/public/scripts/extensions/third-party/st-pocket-phone/
```

确保该目录下直接包含 `manifest.json`、`index.js`、`style.css`，然后刷新酒馆。

## 使用

1. 选择角色（或群聊）后，点击右下角手机按钮打开小手机。
2. 进入 **短信**，发送消息；回复走酒馆当前 API（`generateQuietPrompt`）。
3. 扩展设置（右侧扩展栏）：
   - **启用小手机入口按钮**
   - **短信同步写入主聊天**（默认关闭，避免污染主线）

## 功能范围（v0.1）

- 手机壳、状态栏、桌面图标、Home
- 短信线程（按角色/群聊分别存储在扩展设置里）

后续可能：更多 App、主题、独立 API 双轨等（未包含在本版）。

## 许可

MIT — 见 [LICENSE](LICENSE)。
