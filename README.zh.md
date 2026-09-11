# DSH 子代理协作插件

这是一个可加载的 Cordis 插件 MVP，为 DSH 增加显式同步委托、受限并发批量汇合、结构化父子交接，以及明确的 continuable 子代理回收。

## 工具

- subagent_sync：启动 one-shot 子代理，等待 run.result，返回统一结果 envelope，并在成功、失败、取消、超时后都执行 run.dispose()。
- subagent_batch：以配置的并发上限运行独立 one-shot 任务，按输入顺序返回逐项结果；fail_fast: true 时首个非完成结果会取消运行中的兄弟，并将尚未启动的任务标为取消。
- report_to_parent：continuable 子代理向直接父代理发送版本化 JSON 报告。它只确认 inbox 接收，不是 join、确认回执或 turn 结束。
- delegation_status：读取直接子代理的持久目录，展示 activity、mode、label 和诊断信息。running/inactive 不代表完成状态。
- delegation_finalize：显式回收指定的 direct continuable 子代理，或在父代理生命周期结束时回收全部后代；不会在每次 idle 时自动终止。

插件不修改现有 subagent 工具的 continuable 语义，也不把 send_message 当作任务完成信号。

## 兼容性

目标是 DSH 0.1.5-rc.2 的公开 ctx.subagents、ctx.tools 和 ctx.systemPrompt 契约，Node.js >=22。以下 DSH 包应保持同一 release line：

- @deepseek-ai/cordis ^4.0.2
- @deepseek-ai/dsh-agent、@deepseek-ai/dsh-llm、@deepseek-ai/dsh-subagent、@deepseek-ai/dsh-system-prompt、@deepseek-ai/dsh-tools ^0.1.5-rc.2
- @deepseek-ai/schemastery ^3.18.2

本仓库不执行远端发布；构建后可以从本地 checkout 或 tarball 安装。

## 配置

Host 组合示例：

    - id: subagent-coordination
      name: /absolute/path/to/dsh-subagent-coordination
      config:
        provider: spawn
        maxBatchSize: 8
        maxBatchConcurrency: 4
        defaultTimeoutMs: 120000
        maxTimeoutMs: 900000

Web 中的 model-facing 工具通常属于 agent preset。将相同条目加入选定 preset 的 delegation group（或已经解析 tools、subagents、systemPrompt 的 group）：

    - id: subagent-coordination
      name: /absolute/path/to/dsh-subagent-coordination
      config:
        provider: spawn
        maxBatchSize: 8
        maxBatchConcurrency: 4

不要在 preset 中重新创建 subagents registry 或 provider；它们属于 Host，preset 只应承载该插件的工具注册。

## 结构化结果

subagent_sync 或 batch task 可传 output_schema。它必须是 object-rooted JSON Schema，使用 DSH 支持的子集：type、properties、required、additionalProperties、items、enum、const、oneOf 及注解。子代理成功捕获后，结构化值出现在 result.structured；失败、被取消或没有有效 capture 时不会伪造结构化结果。

report_to_parent 发送的 JSON 包含 type: "dsh/subagent-report"、version: 1、status、summary，以及可选的 details、nextActions。发送成功只表示父代理 inbox 接收了消息，不表示父代理已消费或任务已完成。

## 生命周期

- 调用者取消会传递给所有已启动的 one-shot run。
- 每个子代理的超时会 abort 子代理，并等待其结果/释放路径后返回 cancelled 和 timedOut: true。
- 已发布的 one-shot run 由插件保证只 dispose 一次。
- batch 会等待所有已经启动的任务进入插件清理边界；fail-fast 队列中的未启动任务会返回明确的 cancelled 项。
- delegation_finalize({ child_ids }) 只接受已知的 direct continuable child；all: true 会调用 DSH 的 descendant drain，因此应只在当前父代理生命周期收尾时使用。

## 验证

在 DSH 依赖可用时运行：

    npm run build
    npm test
    npm run check
    npm run pack:check

本仓库的 node_modules 仅用于本地验证并被 Git 忽略；本 MVP 没有执行带认证的 Web GUI 安装或 live GUI 验证。
