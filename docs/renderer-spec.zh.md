# 渲染器参考约定

[English](renderer-spec.md) | 中文

## 权威来源与范围

未改动的 TypeScript 实现及现有测试是参考标准。[renderer-spec.json](renderer-spec.json) 记录入口导出的全部值和类型，以及构建后的原始声明（包括签名、选项、类方法和返回类型）；声明中仅在模块内导出的名称并非额外公共 API。检查或记录快照前须重新构建。本文规定如何保持行为，而非定义新的渲染器 API。

`tools/renderer-schema.mjs` 中仅供工具使用的 Zod schema 严格接收规范化的纯展示数据。按操作区分的输入包含文本、列数、边框行及标签、有序 SGR 参数、markdown 调用或 screen 调用；未知字段一律失败。Cordis 上下文、DSH 事件、服务、后台任务、会话、提供方路由、回调和宿主对象均不得进入 Rust。规范化 schema 刻意只覆盖公共 API 的子集。只有通过下述资源准入的有界整数输入才能跨过此边界；直接调用公共 TS API 的语义不变。被拒绝的规范化工作不得自动通过无界 TS 回退重试。

## 身份、新鲜度与资源准入

每个快照和捕获记录源代码摘要（包括生成的宽度表）、实际执行的 JS/声明构建摘要，以及编译器版本元数据和配置摘要。SHA-256 按排序后的文件名、NUL、文件字节、NUL 计算。工具用仓库现有 tsc 在独立临时目录重新生成 JS 和声明，并逐字节摘要比较；陈旧或被修改的构建在捕获前硬失败。校验后的 JS 和声明字节复制到唯一的临时模块图，显式设置 ESM 包类型并核对构建摘要，然后才动态加载；现存入口或依赖缓存不能提供执行代码；每次捕获重新核对摘要，进程内代码变化须重启，不会用新文件摘要标记旧 ESM 缓存。API 提取器对不认识的入口语法失败关闭。隔离副本测试分别修改行为源代码和执行 JS，证明均能检测；从不修改生产源代码。另一个隔离副本回归先预加载旧模块图，再有效构建已改变的行为，验证捕获执行新行为。

准入上限：单字符串 2048 个 UTF-16 码元；每个集合、调用序列、case 列表和调色板角色表至多 64 项；SGR 数组至多 16 个参数；`codePointWidth.code` 接受 0 至 0x10FFFF 的整数（全部 Unicode 标量值及 TS 保留的代理码元范围）；其他整数仍为 -9999 至 9999；列预算额外限制为 -256 至 256，screen 尺寸限制为 0 至 256。输入总字符串码元（含字段名）至多 8192；显式输入文件在读取和 JSON 解析前限制为 1048576 字节。每次操作的保守输出及工作估计为 `(stringValueUnits + min(maxAbsNumericValue, 256) + arrayEntries + 1)^2 * 1024`；`codePointWidth.code` 是查询键而非分配宽度，对 `maxAbsNumericValue` 贡献为零；捕获对各 case 估计求和，最多 67108864。因子覆盖制表符和控制字符展开、有序 SGR、重复行重放及 screen 调用；输入调色板也受独立字段和总输入限制。超预算在任何渲染调用前拒绝。此准入刻意保守，可拒绝实际上便宜的请求；它不是公共 API 行为定义。

纯 markdown ABI 成功封装精确为 `{ok:true,value:{state,rows}}`，失败为 `{ok:false,error:{code,fallbackEligible:false}}`，code 仅为 `INVALID_INPUT`、`RESOURCE_LIMIT` 或 `BACKEND_FAILURE`。输入、输出和总预算都须验证；输出超限返回 RESOURCE_LIMIT，不输出部分值。捕获 CLI 使用同样的外层形状，但 value 是完整捕获，参考工具错误为 `REFERENCE_FAILURE`；错误不包含原始内容。低层 `capture` 可抛出，稳定接口为 `captureResult`。auto 和强制 rust 都不得将准入失败或原生资源错误转给未经约束的 TS；auto 仅可对已准入的请求因后端不可用而选择 TS。强制 rust 后端不可用返回 BACKEND_FAILURE。直接调用现有 TS API 不受新 schema 限制。第一阶段只规定此选择策略，不实现选择器。

## Unicode 与 UTF-16

宽字符和零宽字符范围以 `packages/renderer/src/width-tables.ts` 为准，不采用库的字素宽度。C0/C1 控制字符宽度为零；可打印 ASCII 为一；零宽范围为零；W/F 范围为二；其他为一。辅助平面字符并非一律占一列：emoji 可占二列，辅助平面字母可占一列。宽度是码点之和，不是扩展字素簇宽度。ZWJ 家庭序列、修饰符和区域指示符保留现有的独立宽度。不得进行 Unicode 规范化。

JS 字符串是 UTF-16 码元序列。有效代理对是一个码点；未配对的高位或低位代理保留原始码元，并占一列。JSON 转义字符串可无损往返。后续原生传输必须使用无损 UTF-16 码元，或对无法保留的字符串明确回退 TS；通过 Rust UTF-8 替换字符转换不等价。截取不得拆分有效代理对。宿主流的 UTF-8 编码（包括替换畸形码元）属于 Node I/O 边界，不属于纯字符串结果。

## ANSI、样式与截取

精确的转义语法是 `width.ts` 中的 `ANSI_PATTERN`：CSI 数字、分号、问号参数和中间字节，或由 BEL 或 ESC 加反斜杠终止的 OSC。不得换成接受范围更广的终端解析器。无法识别的或单独的 ESC 保持零宽字符或 token，保留现有重放行为；后续可打印字符仍计宽。`stripAnsi` 只删除完整匹配的序列。只有 `CSI m` 和 `CSI 0 m` 关闭所跟踪的样式。其他转义（包括仅重置前景色）按顺序追加到重放状态。这是字节级兼容，不是 SGR 语义优化器。

`truncateToWidth` 对非正预算返回空，保留最后一个可容纳字符后的零宽序列，在首个溢出字符前停止，且仅在截断丢弃了开放样式的关闭符时追加完整 reset。未截断的字符串保持原样。`tailToWidth` 保留后缀，不重开截点前的样式；真正截断后删除开头孤立的零宽字符，但保留转义。`fitToWidth` 对整字符截取后的空位补空格。`chunkToWidth` 硬换行；`wrapToWidth` 优先空格，丢弃所选分隔符和续行开头的空格，保留首行缩进。两者都重放开放转义并以完整 reset 关闭行，但边缘情况不同（包括首个过宽字形和空段落），不得合并。`hangingIndent` 预留较宽的 gutter，并截取溢出的组合行。

先转义不可信内容，再逐行添加样式。`escapeControls` 保留 LF，将 C0/DEL 变成 caret 表示，将 C1 写成反斜杠 u 加花括号，并将制表符展开至八位置停靠点；位置按转义后的码点计数，而非显示列。`sanitizePasted` 先将 CR/CRLF 规范化为 LF，并将制表符变成四个空格。`sgr` 保留参数顺序，以完整 reset 结束；空参数保持文本不变。调色板封装拥有可变的进程全局状态、回退选择和幂等恢复。深度零不输出任何样式，缺少的角色不加样式，各角色参数按调用方顺序连接。

Screen 擦除精确使用 `CSI 0K`/`CSI 0J`；背景色擦除（BCE）遵循终端当前样式。不得为了“修正” BCE 插入额外 reset、调色板背景填充或备用屏幕模式。模拟器测试必须检查单元格、属性和光标，而不只是去除样式后的文本。

调色板快照包含按不透明角色键索引、已经解析的有序 SGR 数组，以及 id 和深度（0、4、8 或 24）。TS 宿主在原生调用前折叠编写好的 truecolor、ansi256、ansi 表；原生渲染不探测终端，也不进行最近颜色近似。缺少的角色不贡献参数；深度零不贡献样式。捕获接收可选的已解析快照，并始终在输出中记录实际快照；省略时明确采用导出的 markdown 默认值和深度 4。这使彩色输出独立于进程全局调色板状态而可复现。

## 边框与 markdown

`box` 和 `frame` 是不同的公共原语。保留最小宽度五、四列边框开销、换行、补齐和高度结果。`frame` 将宽度截为整数，把标签中的换行变为空格，左标题优先于右标题，并在边框行中整合页脚和分隔线，不增加标签行。`box` 不采用 `frame` 的转换和标签规则。基于回调的边框样式保留为 TS API：规范化捕获仅通过有序 `border` 参数表示显式 `sgr` 回调子集；任意回调不得跨入原生代码。

Markdown 是仓库面向终端的方言，不是 CommonMark 替代实现：标题、横线、引用、列表、字面围栏和行内链接、代码、强调规则均保持 `markdown.ts` 及其测试的原样。未知或畸形结构保持可见并被转义。链接输出包含括号中的目标。围栏状态保留标记字符和完整开头长度；仅相同字符、长度不少于开头且无信息字符串的标记才能关闭。完整 `line` 调用推进状态；`partial` 读取但绝不改变状态。裁剪后的 partial（`startsLine=false`）保持字面文本，但保留已有围栏样式。按 LF 分割文档包含末尾空源行。分隔符、侧翼检查和 UTF-16 索引必须保留辅助平面字符。

## 状态与宿主边界

第一阶段不改变运行时分派。计划原生化的转换包括宽度及 ANSI 扫描和截取、转义及粘贴规范化、显式 SGR 输出、frame/box 几何计算，以及具有显式围栏状态的纯 markdown 行转换。TS 保留为参考和回退。`style` 和 `paint` 仍是 TS 封装，将名称和角色解析为有序 SGR 参数。`paintGlint`、spinner、耗时和 token 格式化可调用原生宽度及截取，但编排留在 TS。Composer 缓冲区、历史、折叠、动作，`layoutComposer` 投影及反向映射，键盘解码和终端获取都留在 TS。它们可使用原生宽度及截取，但不转移状态机。composer 回调或映射闭包不得跨界。

`createMarkdownRenderer` 在 TS 中保留文档状态。规定的纯原生 markdown 状态转移接收 `{state: {fence: string|null}, palette: {id, depth, roles}, text, mode: "line"|"partial", startsLine: boolean}`，返回 `{state: {fence: string|null}, rows: string[]}`。围栏为 null 或完整的开头反引号、波浪号序列（至少三个相同标记）。`line` 识别至多三个开头空格、标记序列及后续信息：围栏外记录完整序列，将去除两端空白后的非空信息以 muted 样式输出；围栏内仅在标记相同、长度不少于开头且去除空白后信息为空时关闭。其他情况状态不变。`partial` 始终返回完全相同的输入状态；`startsLine=false` 时输出转义后的字面散文或现有缩进代码样式，绝不解析后缀语法。partial 的 rows 是现有封装字符串作为一个数组元素（包括空字符串）；line 的 rows 等于现有 `line` 结果。TS 封装连接 partial 行，保留字符串返回类型。机器可读 schema 明确规定状态转移的输入和输出；第一阶段不实现原生转移或分派。`renderMarkdown` 仍是 TS 文档循环。Screen 仍是唯一 TS 终端写入方和实时区域状态所有者；只有换行可进入原生分派。捕获中的 `screenSequence` 是参考观察配方，不是原生 screen 服务提案。

Screen 在实时区域上方提交不可变滚动缓冲区，按当前宽度换行（至少为一），忽略空提交，并重画保存的实时行。只有当前画面可信时，相同的换行后行、光标和宽度才跳过写入。光标行限制在实时区域内，列至少为零。`markStale` 使信任失效，但保留已绘制的几何信息。resize 擦除采用缓存的已绘制高度，绝不采用重排后的历史；终端自身重排仍可能在通知前把旧像素滚入历史。同步更新、隐藏和显示光标、CR/LF 及逐行擦除序列必须精确保留。`close` 即使写入失败也在 `finally` 中清除缓存几何。I/O 错误、流编码、raw mode、终端模式、定时器、尺寸、按键订阅和 resize 通知都由 TS 宿主拥有。

## 捕获与待补证据

构建后运行确定性合成捕获，或明确提供规范化观察数据。输出包含规范化输入、来源、实时 TypeScript 调用的实际返回值，以及每次 Screen 调用写入的字符串和高度。即使输出来自实际调用，合成输入仍标为合成。不会读取原始日志、profile 路径、自动枚举会话、凭据或私人会话。会话观察仅可由明确命名的 JSON 文件主动提供，要求 `observed` 来源和 `explicitly-provided-normalized-data` 同意标记；调用者必须先规范化并脱敏。工具绝不从 DSH 事件推测渲染器输入。

```sh
pnpm build
node tools/renderer-spec.mjs --write
node tools/renderer-spec.mjs
node tools/renderer-capture.mjs --synthetic /tmp/renderer-capture.json
node tools/renderer-capture.mjs --session-input /tmp/normalized-observation.json > /tmp/observed-capture.json
```

第一阶段包含捕获机制和小型确定性演示，不包含第二阶段的广泛语料或差分测试框架。待补证据包括：获得同意的代表性规范化会话样本、更广泛的调色板深度和自定义角色情况、完整畸形 ANSI 矩阵、composer 投影和键盘宿主回归、终端 resize/BCE 属性及性能负载。第二阶段必须先补足证据，才能接受 Rust 库默认行为或传输决策。现有模拟器和渲染器测试仍为权威；API 快照检查不能代替行为测试。
