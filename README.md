# i-Chat (`obsidian-i-chat`)

> **Version**: `0.2.2` · **Min Obsidian**: `1.11.0+` · **Platform**: Obsidian Desktop Only · **Author**: KrayZerld & Geminyan

一款面向 Obsidian 桌面端的轻量级原生对话插件：基于 Obsidian 默认主题变量与 1.11+ 原生设计语言打造，支持多平台 BYOK（Google AI 与 OpenAI Compatible）、`@` 快速提及笔记/当前活跃笔记、Gemini 原生联网搜索、首轮对话自动生成标题、流畅流式输出、默认折叠的思考过程、多模态附件与 Excel 表格智能粘贴、提示词与模型双向绑定，以及自动落盘为清爽可读的 Markdown 对话笔记。

---

## 核心特性

- **原生编辑区与现代阅读体验**
  - 通过命令 `Open i-Chat` / `Start new i-Chat conversation` 或左侧 Ribbon 图标，直接在编辑栏以独立标签页打开对话窗口。
  - 标签页与顶部标题栏实时同步当前对话标题；宽屏居中阅读排版（`780px`）、中文优化行高与问答间距分层、消息元信息悬停降噪、悬浮输入区顶部渐变羽化、长对话「回到底部」悬浮按钮。
  - Composer 提示文本随上下文动态切换：选中提示词时显示 `Ask <i-chat-title>` / `Reply to <i-chat-title>`，未选提示词时自动回退至当前模型名称。
  - 代码块复用 Obsidian 原生 `markdown-rendered` 样式与中文无衬线字体回退；设置页采用 Obsidian 1.11+ 原生分组卡片布局。
- **BYOK 多平台支持（内置 5 个平台）**
  - 内置 **Google AI**、**OpenAI**、**DeepSeek**、**OpenRouter** 与 **OpenAI Compatible**，按平台独立保存 API Key、Base URL（留空自动使用默认地址）与测试状态（未测试 / OK / ERR），切换平台互不覆盖。
  - 点击测试连接自动拉取可用模型清单，自动识别 `Visual` / `Think` 能力，支持搜索与「启用优先 / 按时间」排序；兼容多模态图片、`reasoning_content` / `reasoning` 思考流及 `reasoning_effort`。
- **原生联网搜索（Google AI & DeepSeek）**
  - 选中 Google AI 模型或 DeepSeek `deepseek-flash` 时工具栏显示地球图标开关（默认关闭）；开启后分别启用 Google Search Grounding 或 DeepSeek 服务端 `deepseek_web_search` + `deepseek_read_url`，并在助手回复下方以默认折叠的「参考来源 (N)」区块展示去重后的网页链接（仅当前 UI 展示、不写入对话笔记）。
- **`@` 快速提及笔记与多模态附件（仅当前会话有效）**
  - 在输入框输入 `@` 呼出模糊搜索面板（支持 `↑ / ↓ / Enter / Tab / Esc`，精简展示前 3 个候选项），置顶追踪最近聚焦的非 i-Chat Markdown 笔记（优先展示 Frontmatter `title` 字段值），下方支持检索 Vault 笔记与文件夹；选中后自动清除 `@关键词` 并去重挂载到附件区。
  - 支持点击 `+` 打开系统文件选择器、`Ctrl+V` 粘贴文件/截图（粘贴 Excel 等表格时自动转换为 Markdown 表格而非图片附件），以及**直接拖拽 Obsidian 笔记/文件夹或系统文件/文件夹**添加附件（单次最多 50 个文件）。
  - 附件标签仅展示文件名，且不落盘到对话笔记中。
- **流畅流式输出与思考过程**
  - 采用单飞双缓冲离屏渲染，流式输出无闪烁、无卡顿，随时可点击停止生成。
  - 支持思考能力的模型可切换 `Low / Medium / High` 思考等级；思考过程默认折叠，生成时带主题色星光呼吸提示，仅在当前界面展示、不写入笔记。
- **提示词与模型双向绑定**
  - 扫描提示词目录下的 Markdown 文件，选择器展示 Frontmatter 中的 `i-chat-title`（未选择时显示 `Default`，下拉项为 `默认`）。
  - 切换提示词时自动切至该提示词绑定的模型与思考等级；在选中提示词状态下手动切换模型或思考等级时，自动写回该提示词的 Frontmatter（保留其他自定义属性）；若提示词文件缺少 Frontmatter，在使用时会自动补全。
- **纯净 Markdown 对话记录与自动生成标题**
  - 对话自动保存为 `{YYYYMMDDhhmmss}.md`（同秒自动加 `-2`、`-3` 防冲突），首轮保存后在后台复用当前对话模型静默提炼简短标题写回 `i-chat-title` 并同步标签页标题（若期间手动重命名则绝不覆盖）。
  - 支持历史对话搜索、标题重命名、删除以及最后一轮消息一键重试；打开历史对话时自动恢复提示词与模型（优先级：提示词绑定模型 → 笔记记录模型 → 保持当前模型并提示）。

---

## 安装与部署（手动安装）

> 最低支持 **Obsidian 1.11.0**（桌面端）。

1. 在本地执行构建（或获取已构建产物），准备好以下 3 个文件：
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. 在你的 Obsidian Vault 目录下创建插件目录：
   ```text
   <YourVault>/.obsidian/plugins/obsidian-i-chat/
   ```
3. 将上述 3 个文件复制到该目录中。
4. 打开 Obsidian → **设置 → 第三方插件**，刷新插件列表并启用 **i-Chat**。

---

## 快速上手

1. 打开 **设置 → i-Chat → BYOK**：
   - 选择平台（支持 `Google AI`、`OpenAI`、`DeepSeek`、`OpenRouter`、`OpenAI Compatible`），填入 API Key（Base URL 留空时自动使用默认地址）；
   - 点击右侧测试图标拉取模型清单，并勾选要启用的模型。
2. 切换到 **设置 → i-Chat → 对话**：
   - 配置默认思考等级、提示词目录与对话记录保存目录。
3. 使用左侧功能区图标或命令面板运行 **Open i-Chat** 开始对话。

---

## Frontmatter 与笔记格式规范

### 提示词文件 Frontmatter

```yaml
---
i-chat-title: Geminyan
i-chat-platform: google-ai
i-chat-model: gemini-2.5-flash
i-chat-thinking: high
---

这里编写系统提示词正文（发送时会自动去除 Frontmatter）。
```

> 说明：若提示词文件缺少 Frontmatter 或缺少 `i-chat-*` 字段，选中或使用该提示词时会自动补全，并完整保留其他自定义属性。

### 对话记录笔记格式

每完成一轮对话或重试时自动更新（保留手动修改过的 `i-chat-title`）：

```yaml
---
i-chat-title: 截取对话前15字
i-chat-prompt: Agent.md
i-chat-platform: google-ai
i-chat-model: gemini-2.5-flash
i-chat-thinking: high
---

2026-11-22 19:56:26
Hi Geminyan!

---

2026-11-22 19:56:48
Hi Captain

---
```

> 说明：未选择提示词时自动省略 `i-chat-prompt`；所选模型不支持 Think 能力时自动省略 `i-chat-thinking`。解析器同时向下兼容早期带 ```` ```markdown ```` 围栏包裹的历史对话笔记。

---

## 更新日志

### `0.2.2`
- **新增**：DeepSeek `deepseek-flash` 原生联网搜索支持（启用服务端 `deepseek_web_search` 与 `deepseek_read_url`，识别 `Visual` / `Think` 能力与三档思考深度，解析 `url_citation` 参考来源并在当前会话多轮续聊时静默回传 `server_tool_calls`）。
- **优化**：前端控件全面 Obsidian 原生化（BYOK 平台选择器与排序下拉改用 `DropdownComponent`、模型清单原生 `setting-group` + `Toggle`、全项目搜索框改用 `SearchComponent`、API Key 按钮改用 `ExtraButtonComponent`、`HistoryModal` 接入 `setTitle` 与 `TextComponent`、全插件无框图标按钮统一使用 `.clickable-icon`）。
- **修复**：聊天气泡与思考块中代码块的复制按钮随水平滚动滑走的问题（滚动下沉至 `pre > code`，复制按钮始终固定在可视区右上角）。

### `0.2.1`
- **新增**：`@` 快速提及笔记（置顶追踪当前活跃笔记 Frontmatter `title`，精简前 3 项候选项，自动去重挂载附件）。
- **新增**：OpenAI Compatible 通用适配（内置 Google AI、OpenAI、DeepSeek、OpenRouter、OpenAI Compatible 5 个平台，兼容多模态与推理思考流）。
- **新增**：Gemini 原生联网搜索开关与可折叠「参考来源」链接区块（UI-only，不落盘）。
- **新增**：首轮对话后台静默自动生成标题并安全写回 `i-chat-title`。
- **优化**：Excel 表格智能粘贴转 Markdown 表格；缺少 Frontmatter 的提示词使用后自动补全；Composer 动态 Placeholder（`Ask ...` / `Reply to ...`）；聊天窗排版降噪、顶部渐变羽化、工具栏分组与长对话「回到底部」悬浮按钮；设置页全面对齐 Obsidian 1.11+ 连体分组卡片样式（`minAppVersion` 升至 `1.11.0`）。

### `0.1.0`
- 首个可用版本：Google AI BYOK、双缓冲流式输出、默认折叠思考过程、拖拽/粘贴附件、提示词与模型双向绑定、纯净 Markdown 对话笔记与历史管理。

---

## 本地开发

```bash
# 安装依赖
npm install

# 开发监听构建
npm run dev

# 类型检查
npm run typecheck

# 运行单元测试
npm test

# 生产构建（输出 main.js）
npm run build
```

---

## License / Credits

Created by **KrayZerld & Geminyan**.
