# Pocket Phone 小手机（st-pocket-phone）

SillyTavern 第三方 UI 扩展：角色绑定短信、全屏 H5、可编辑预设、双发送按钮、多条 `<msg>` 解析。

## 安装

扩展 → 安装扩展 → 粘贴：

```text
https://github.com/vpocket-99/st-pocket-phone
```

或 symlink 到 `SillyTavern/public/scripts/extensions/third-party/st-pocket-phone/`。

## 怎么用

1. 进入角色对话。
2. 点输入框左侧 **汉堡菜单（二级窗口）→「小手机」**。
3. **短信**：`发送气泡` 可连发多条用户消息；`请求回复` 才调用模型。
4. **API**：酒馆当前 API / 自定义 URL+Key；支持一键接入。
5. **预设**：编辑系统提示词（默认对齐本地 Phone Reply 的 `<msg>` 连发协议）。

## 输出协议（模型侧）

参考仓库内 `default-preset.txt`，以及提示词工程里的：

- `rp提示词/phone-reply本地版-繁体中文.md`
- `rp提示词/小手机风格条目.md`

模型应只输出：

```xml
<msg>第一条</msg>
<msg>第二条</msg>
```

扩展会解析成多个气泡。

## 许可

MIT
