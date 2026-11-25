# 蓝湖设计结构助手（非官方）

Chrome Manifest V3 扩展，用于查看蓝湖设计稿结构并复制节点 JSON，供用户交给 AI 辅助生成前端代码。需要 Chrome 102+。

扩展本身不调用 AI 服务、不自动上传设计数据，也不直接生成代码。向外部 AI 提交 JSON 前，请确认设计数据允许外传；生成结果仍需人工检查。

本项目是独立开发的第三方辅助工具，非蓝湖官方产品，与蓝湖不存在官方隶属或背书关系。仅处理你有权访问的设计，请遵守蓝湖服务条款及所在组织的数据保密要求。

## 文档导航

- [安装与使用](#安装与使用)
- [隐私政策](PRIVACY.md) · [Chrome Web Store 发布指南](STORE_LISTING.md)
- [复制 JSON 约定](#复制-json-约定) · [转换细则](CONVERSION_RULES.md)
- [状态与限制](#状态与限制) · [故障排除](#故障排除)
- [代码结构](#代码结构) · [开发与构建](#开发与构建)

## 功能

- 自动获取 schema，在可拖动面板中展示结构树，支持折叠、选中和页面双向定位。
- 复制节点及子树，支持备注、删除确认。发布包固定不输出节点 ID；源码开发版保留“含ID”调试开关。
- 支持图片倍率（1/2/3 倍）和 PNG、JPG、WebP、SVG 格式选择。
- 优先使用可确认的完整导出切图；没有完整切图时，将可验证的简单背景、边框、渐变、阴影及组合装饰转换为 CSS 或内联 SVG。无法确认外观一致时保留图片，缩略图仍显示原图。

## 安装与使用

1. 下载项目，在 `chrome://extensions/` 开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择项目目录。
3. 从蓝湖设计详情页（`https://lanhuapp.com/web/#/item/project/detailDetach?...`）点击“代码”，进入对应 DDS iframe（`https://dds.lanhuapp.com/...`），等待左下角结构面板加载；不以直接 DDS 链接代替详情页完整数据链路。
4. 点击节点左侧箭头折叠/展开，点击节点名称定位页面元素；点击页面元素可定位树节点。
5. 悬停节点使用复制、备注或删除按钮；标题栏可调整图片参数和“含ID”开关。
6. 拖动标题栏移动面板，点击 × 关闭，通过“结构”按钮重新打开。
7. 核对并按需脱敏复制的 JSON，再手动粘贴至你选择的 AI 编程工具，说明目标技术栈、组件边界和布局要求，辅助生成前端代码。AI 服务的数据处理受其自身政策约束，本扩展不会自动发送数据。

## 复制 JSON 约定

本节为消费方的基本输出契约；插件的源数据证明、布局恢复及绘制转换条件集中在 [JSON 转换规则](CONVERSION_RULES.md)，验证时不得据此再次修补布局。

### 节点与标识

- 输出类型为 `page`、`block`、`text`、`image`；DDS 的 `button`、自定义或缺失类型按布局容器映射为 `block`，保留样式及有序子节点，不引入原生控件默认样式，不根据 bounds 补宽高或根据 value 猜测文本/图片。
- 默认不输出 `id`、`layerId`；开启“含ID”后递归保留已有标识。始终剔除内部 `treeKey`、`className` 和 `prompt`。
- 循环副本可能共享原始标识，消费方需结合树路径和循环上下文区分。
- 生成的无 id 装饰节点不可寻址，不参与页面与面板树的双向联动，但仍保留在节点树和复制结果中；插件不会为其伪造可与官方 DOM 对应的 id。
- 完整数值 `rowDims` 输出为 `bounds: {left, top, width, height}`，是画布绝对坐标，不能直接覆盖相对布局 CSS。循环副本沿用模板 bounds，不代表实际位置；不完整坐标不补齐。
- 远程图片下载建议位于复制根节点的 `_meta.instructions`；`_meta` 不应作为 DOM 属性或 CSS 渲染。

### 文本与样式

- 文本节点使用行内 `<span>`，显式输出 `display: "inline"`；保留的宽高不改变行内布局语义。文本字段按 `data.value` → `props.text` → `value` 的空值优先级选取，仅 `null`/缺失触发回退；`0`、`false` 和显式空字符串保留在 JSON 中，显示时转为字符串。
- `textFormat: "html"` 表示 `text` 已是 HTML 片段，保留 `&nbsp;`、`<br/>`，不要重复转义。不可信来源须先安全净化，插件不保证片段安全。
- 长度属性的裸数值字符串转为 Number。渲染时数值长度补 `px`（含数值 `lineHeight`），`fontWeight`、`opacity` 等无单位属性不补；已有单位、百分比和 CSS 表达式保持原样。
- **`fontSize: 0` 的 JSON/CSS 语义仍为零字号**：忠实消费及机械验证必须输出 `font-size: 0px`，不把零值视为缺失。历史消费建议中的“省略零字号以继承父级”是可选的下游外观适配，不是 JSON 契约；它可能改变行内间隙及多行行盒（历史样本有 ≤10px 差异），不得将该结果作为原样还原的验证证据。示例：`{ style: { fontSize: 0 } }` → `font-size: 0px`；`{ style: {} }` → 不声明字号。
- `boxSizing` 默认为 `border-box`，不覆盖已有值。
- `convertedFrom.sourceStyle` 是归一化后的样式快照，不是上游原始样式。

## 状态与限制

- **JSON 不含画板底色，需消费方自行设定**；节点明确输出的背景样式仍须保留。透明设计导出应按相同底色进行 alpha 合成后比较，不能仅凭原始 RGB 判定背景缺失；不要据此给所有页面注入黑底。
- 后台按标签页通过 `chrome.storage.session` 缓存最近一次 schema、图片数据及矢量索引，支持 Worker 重启后补拉；关闭标签页清理缓存。浏览器重启或扩展重新加载后不保证保留。**当前缓存未校验设计身份**，同标签切稿仍有取得旧数据的风险；复制或删除前须人工核对当前设计，不把恢复缓存视为身份验证。
- 存储超限时降级为仅缓存 schema，仍失败则清除旧快照；不阻断当前页面推送。schema/API JSON 补拉超时为 15 秒。
- 面板设置仍按 DDS 页面来源使用 localStorage；读取失败使用默认值，写入失败只保留本页设置，不阻断初始化和参数应用。尚未迁移到扩展存储。
- 同设计内切换图片参数或接收新数据会保留备注、删除标记、折叠、选中和滚动状态；切换设计或刷新页面不保留。结构重排后不保证备注跟随业务对象，重绘会关闭未提交的备注弹窗。
- 重复 ID、循环共享 ID 或无原始 ID 的节点可在面板内操作，但不猜测官方 DOM 实例，不执行页面联动或删除。
- 删除需确认，并通过 Backspace 请求官方页面删除；只有目标 DOM 持续消失至少 120ms 才移除树项，1.5 秒超时或期间页面/设计更新则保留。此检查不保证服务端保存成功，也不提供撤销。
- 复杂曲线、照片、截图、无法验证的裁剪/旋转/效果继续使用图片。
- 文字排版依赖本机字体；跨平台缺少原字体会改变换行位置、度量和对齐。输出将 `PingFangSC-Regular` 转换为 `PingFangSC-Medium`，并把蓝湖导出的 PostScript 风格名字改写为浏览器可匹配的家族名：`MicrosoftYaHei*` → `Microsoft Ya Hei`、`AlibabaPuHuiTi-Bold` → `Alibaba PuHuiTi`、`DIN-Bold` → `DIN`、`DINPro-Medium` → `DINPro`、`FZFW-QingYinTiS-E--GB1-0` → `FZFW Qing Yin TiS E`、`AdobeHeitiStd-Regular` → `Adobe Heiti Std`。显式 `fontWeight` 始终优先，仅 `MicrosoftYaHeiSemibold` 在源字重为 `normal` 时补 `600`；其余原始 `fontFamily` 保留，`FontName` 等源稿占位符文名不改写并可由 `getFontRewriteStats` 统计；插件无法提供字体文件。请合法安装或加载原字体；使用回退字体后需重新检查排版。

## 故障排除

- **面板不显示或无数据**：确认页面为 `dds.lanhuapp.com`、扩展已加载，并检查网络中的 schema.json 请求及扩展 Service Worker 日志。
- **高DPR图片模糊**：DPR2/3页面优先选择@2x/@3x，保持CSS宽高不变；倍率不能提高原始低分辨率素材的真实细节，也不保证覆盖所有引用。
- **图片参数仅部分生效**：面板统计无法改写的远程图片引用数，倍率/格式不保证覆盖全部图片。若提示缺少图片倍率/矢量还原数据，请从蓝湖项目详情页打开设计并等待请求完成；直接访问 DDS 链接可能仅取得 schema。
- **复制失败**：检查剪贴板访问限制，使用 HTTPS 页面。
- **联动失败**：确认 schema 已加载且页面存在唯一对应 ID；重复 ID 和无 ID 节点不参与联动。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 扩展权限与脚本配置 |
| `background.js` / `background_controller.js` | 请求监听、数据补拉与会话缓存 |
| `content.js` / `content.css` | 面板交互与样式 |
| `schema_parser.js` | schema 解析、循环展开和样式归一化 |
| `vector_style_helper.js` | 图层索引、矢量转换与保守回退 |
| `tree_state.js` / `tree_renderer.js` / `tree_helper.js` | 树状态、增量渲染与查找 |
| `content_copy_formatter.js` / `clipboard_helper.js` | JSON 格式化与剪贴板操作 |
| `content_sync_helper.js` | 页面定位与删除确认 |

## 开发与构建

在仓库根目录执行（Node.js、pnpm）：

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm build
```

`lint` 只做 JS/JSON 语法检查，不检查语义或未定义变量。`build` 生成扩展构建产物：
`dist/chrome-extension-lanhu-helper/`（可直接加载的解压目录）与
`dist/chrome-extension-lanhu-helper.zip`（Chrome Web Store 上传包）；构建产物随仓库提交，
改动源码后需重新执行 `pnpm build` 并提交。

本仓库只公开扩展核心源码、图标、构建入口与上架文档。自动化测试、JSON 还原验证工具、设计证据与
私有缓存属于本地开发仓库（其中可能含私有设计数据），不在此公开。

上架流程、素材与验收清单见 [Chrome Web Store 发布指南](STORE_LISTING.md)，数据处理说明见
[隐私政策](PRIVACY.md)。
