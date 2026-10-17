# 原生失败后的单次 auto 恢复

[English](renderer-auto-recovery.md) | 中文

这是草稿 [PR #302](https://github.com/riesbri/dshline/pull/302) 独立审查发现 M1 的后续修复。
此处 M1 是审查发现编号，并非仅指 Apple Silicon 行为。
TS 仍为默认。原生准入、五个守卫、Unicode 协商、阈值、编译策略及强制 rust 选择不变。

## 分类与模式

分类位于 `packages/renderer/src/native-primitives.ts` 的 `nativeFailure`。
精确的 `RESOURCE_LIMIT` 或 `INVALID_INPUT` code 优先，其次检查精确的终止类消息
（napi-rs 提供 `code: GenericFailure`，把我们的代码放在 message 中）。字面终止代码
抛出也被保留。其余原生抛出，包括捕获的 panic 和显式 `BACKEND_FAILURE`，
归一为 `BACKEND_FAILURE`；原生返回形状错误本来就使用该类。
未知原生错误属于后端失败，不推测为调用方错误。不做子串匹配，也不暴露原生错误载荷。

| 准入后失败 | auto | 强制 rust |
| --- | --- | --- |
| `BACKEND_FAILURE`（含捕获的 panic / 无效响应） | 执行一次 TS 参考 | 抛出 |
| `RESOURCE_LIMIT` | 抛出；不重试 TS | 抛出 |
| `INVALID_INPUT` | 抛出；不重试 TS | 抛出 |
| 恢复期间 TS 参考抛出 | 原样传播该 TS 错误；不再重试 | 不适用 |

`recover` 只在 `unary`、`cut` 已准入的直接原生调用周围应用此策略。
auto 不新增复合操作或单码点查找准入。缺失 addon/方法、不支持的值和 Unicode 不兼容，
保持原有执行前 TS 选择。强制 rust 仍抛出：调用方明确要求原生执行，准入后悄悄替换
后端会违背该选择。原有执行前宿主/Unicode 回退不变。

## 一次原生尝试，然后调用原有 TS 参考

没有重试循环，也不对失败操作再次调用原生。仅 auto 中归一化的 `BACKEND_FAILURE`
进入恢复辅助函数。它用原始字符串/预算调用现有参考函数，不强制转换、截断、
更换宽度规则或另写实现。

恢复在整个同步参考调用期间将选择临时固定为 `typescript`，并在 `finally` 中恢复，
即使参考自身抛出也如此。这对 `fitToWidth` 很重要：其 TS 实现调用模式相关宽度叶子。
没有作用域固定，简单的参考重试可能重新进入失败的原生后端，不再是纯 TS 参考。
回调、异步工作和终端写入不跨越此纯叶子边界。Screen/frame 仍为 TS 宿主；
仅它们各自的纯叶子失败会恢复。一次失败不会永久禁用 addon。

归一化原始 ABI/工具封装及对外错误仍携带 `fallbackEligible: false`。
协议没有扩大：auto 在对外抛出前消耗特定内部后端失败类。
归一化请求拒绝、调用方错误和强制 rust 执行绝不重试。

## 测试与证据

- 三个新增边界测试在旧实现上失败：五个已准入操作 × 四种失败形式在 auto 中精确
  返回 TS，而强制 rust 仍抛出；计数证明原生仅尝试一次；带计数的参考证明 TS 也仅
  尝试一次，并在抛出精确 TS 哨兵错误后恢复选择。
- 两个终止代码、napi 风格消息、类型错误和字面抛出，在五个操作的 auto 与强制 rust
  中均检查（60 个断言）。
- 第四个测试在原生叶子抛出后端错误时，精确比较显式 TS 的 Screen 写入、回调帧输出
  及回调顺序。
- 历史守卫测试现在在原生抛出之外显式断言禁止的原生调用次数。恢复不能隐藏被删守卫。
  审计检查这一见证，不再要求后端错误向外传播。
- `tools/renderer-recovery-audit.mjs` 分别移除恢复、TS 作用域、终止错误排除和强制 rust
  排除，再分别移除五个守卫。每个错误构建都必须因指定行为断言失败。
  只变异可丢弃的编译副本，并始终在 `finally` 中清理临时目录。

故障注入在真实 JS 加载边界使用模拟 addon，不是真正的 Rust panic，也不引入编译/
panic 策略。现有真实 addon 对比和跨平台 CI 仍是必要检查。全部 86 个黄金请求/输出
及公开 API 签名不变；刷新样例源码/构建身份。此前性能记录仍绑定原始测量提交；
此正确性修复不改标旧记录，也不声称获得新的计时结果。

```sh
pnpm build
node tools/build-renderer-native.mjs --required
pnpm exec vitest run tools/renderer-native.spec.mjs tools/renderer-leaf.spec.mjs tools/renderer-lookup.spec.mjs
node tools/renderer-recovery-audit.mjs benchmarks/renderer-auto-recovery-audit.json
```

仅供测试的 `DSHLINE_TEST_RENDERER_LIB` 接缝提供这些私有副本；已验证的根构建逐字节不变。
审计期间不要并行构建、测试或计时。PR 仍为草稿；不合并、发布或安装到配置。
