# 有效上下文窗口研究：多大比例的标称窗口是"实际可用"的？

> 研究动机：`extensions/tc-footer.ts` 用 450k 作为 1M 窗口模型的显示上限（EFFECTIVE_CONTEXT_TOKENS），并给被截断的窗口设 65% 红线。用户实测"略超 Smart Zone（>450k）时 Agent 执行完全没问题"。本文回答：这个现象的机制是什么？450k/65% 是否过于保守？研究到底支持什么？
>
> 写作日期：2026-02。除"本地源码查证"外，所有结论均附一手来源链接；无法追到一手来源的说法标注"未验证"。

## TL;DR

**没有哪个权威来源给出"窗口的 X% 是安全线"这样的统一数字。** 研究给出的证据分两层：

1. **硬边界**（标称窗口本身）：各家主流 API（Anthropic/OpenAI/Gemini）在输入超过标称窗口时返回 400 错误，不会静默截断。Agent 框架必须在到达硬边界前自行 compaction——这是所有 compaction 阈值存在的唯一硬性理由。
2. **质量边界**（退化从哪开始）：已发表的量化研究测的全部是**检索/复述类任务**（大海捞针、多跳追踪、聚合、长对话记忆 QA），不是 agent 多步循环。它们显示退化"远早于窗口填满"且没有统一的百分比悬崖；agent 循环执行对满窗口的容忍度没有等量的对照实验，只有间接证据表明它比长文档检索更宽容。

**最关键的参照数字**：Claude Code（生产级 coding agent，与用户"实测没问题"的场景最可比）的 auto-compact 阈值是 `窗口 − 20k(摘要预留) − 13k(buffer)`——200K 窗口在 **83.5%** 触发，1M 窗口在 **96.7%**（≈967k）触发。pi 是 `窗口 − 16384`——1M 窗口到 **98.4%**（≈983,616）才真正 compaction。**质量研究给 footer 的支持是方向性的（早提醒比晚提醒好），而不是数值性的（65% 不是研究得出的悬崖）。**

## 1. 硬边界 vs 质量边界：先解释"略超 450k 还能跑"

这两件事在机制上完全独立：

- **450k 只是显示层**。`tc-footer.ts` 的 `effectivePercent()` 把分母从 `contextWindow` 换成 `min(contextWindow, 450_000)`，仅影响百分比数字、进度条和颜色。pi 的 compaction（`shouldCompact`）用的是**真实标称窗口**（见 §6）。所以"上下文 102% of Smart Zone 还能正常执行"在机制上是必然的——此时对 1M 模型而言真实占用才 45 万/100 万 ≈ 45%，离 pi 的 compaction 触发点（983,616）远得很。
- **质量退化研究测的不是"会不会跑"，是"跑得好不好"**。且它们测的是检索/复述任务（§3），agent 循环对旧上下文的依赖低得多（§4）。所以 footer 在 450k 处截断+65% 红线是一个"提前示警"的 UI 决策，不是硬机制，也不对应某个研究测出的性能悬崖。

## 2. 权威研究的具体数字（全部为检索/复述类任务）

### 2.1 Chroma "Context Rot"（2025-07）

来源：*Context Rot: How Increasing Input Tokens Impacts LLM Performance*, Kelly Hong, Anton Troynikov, Jeff Huber, Chroma, 2025-07-16（报告内 footnote 标注更新日期）。原文：<https://research.trychroma.com/context-rot>（镜像 <https://www.trychroma.com/research/context-rot>）；复现代码库：<https://github.com/chroma-core/context-rot>。

- 18 个模型：Claude Opus 4 / Sonnet 4 / 3.7 / 3.5 / Haiku 3.5，o3，GPT-4.1 / mini / nano / 4o / 4 Turbo / 3.5 Turbo，Gemini 2.5 Pro / 2.5 Flash / 2.0 Flash，Qwen3-235B / 32B / 8B。
- **核心结论：所有 18 个模型在所有实验中性能都随输入长度退化，即使任务极简单**（逐词复写、非词法检索）。原文："Across all experiments, model performance consistently degrades with increasing input length."
- 实验设计刻意**只变长度、不变任务难度**，以隔离长度因素——并明确指出真实应用复杂度更高，"implying that the influence of input length may be even more pronounced in practice"（即研究测出的是下界）。
- 定量发现（原文正文给出的）：
  - needle–question 相似度越低，随长度退化越快（嵌入余弦相似度分组对照）。
  - distractor（主题相关但不对的干扰项）的杀伤随输入长度放大；4 distractor 条件下幻觉明显增多。Claude 系幻觉率最低、倾向弃答；GPT 系幻觉率最高。
  - **LongMemEval 对话记忆 QA**：focused 输入（~300 tokens）vs full 输入（~113k tokens），全模型显著差距，Claude 家族差距最大（长输入下弃答："I cannot determine the number of days… not provided in the chat history"，而日期就在上下文里）。
  - **Repeated Words 复写**：性能随长度全线退化；GPT-4.1 拒答率 2.55%（约 2500 词起）；GPT-3.5 Turbo 因 60.29% 拒答被整体剔除；Claude Opus 4 是唯一拒答的 Claude（2.89%），且 Opus 4 退化率最慢。
- **注意**：正文没有给"从多少 token 开始掉、掉多少百分点"的统一数字——退化曲线是逐模型图片，各模型差异很大。二手转述中的"30%+ 掉落""1k token 就显著退化"等数字**未在原文数字上核实，未验证**。
- **任务类型**：NIAH 非词法变体、长对话记忆 QA、逐词复写——纯检索/复述，无 agent 循环。

### 2.2 RULER（NVIDIA，COLM 2024）

来源：*RULER: What's the Real Context Size of Your Long-Context Language Models?*, Hsieh et al., arXiv:2404.06654（v1 2024-04-09，v3 2024-08-06），<https://arxiv.org/abs/2404.06654>；表格：<https://github.com/NVIDIA/RULER>。

- **"有效长度"定义（一手）**："We use the performance of Llama2-7b model at the 4K context length as the threshold"——即加权平均分 ≥ **85.6%** 的最长测试长度。这是**任意设定的定性阈值**，不是质量悬崖。
- 13 个合成任务、4 类：NIAH 变体检索（S/MK/MV/MQ-NIAH）、variable tracking（多跳追踪）、common/frequent words extraction（聚合）、加干扰 QA。**全部是合成检索/追踪/聚合任务**。
- 摘要结论："While these models all claim context sizes of 32K tokens or greater, only half of them can maintain satisfactory performance at the length of 32K."（2024 年模型生态）
- 代表性数字（GitHub README 主表，(claimed → effective)）：
  - **GPT-4-1106-preview：128K → 64K**（各长度得分 96.6 / 96.3 / 95.2 / 93.2 / 87.0 / 81.2@128K）
  - **Gemini-1.5-pro：1M → >128K**（128K 时仍 94.4，是所测最长点）
  - Llama3.1-70B：128K → 64K（128K 时 66.6）
  - Command-R-plus：128K → 32K；Mistral-Large-2407：128K → 32K（128K 时崩到 23.7）
- **局限（引用时必须注明）**：2024 年模型；未测 Claude 商业模型、未测 GPT-4o/4.1；测试上限 128K；任务与 coding agent 工作负载无重叠。它证明的是"当年半数模型的名义窗口有水分"，不能外推为"今天的 1M 模型只能用 50%"。

### 2.3 NoLiMa（Adobe Research，ICML 2025）

来源：*NoLiMa: Long-Context Evaluation Beyond Literal Matching*, Modarressi et al., arXiv:2502.05167（v1 2025-02-07），<https://arxiv.org/abs/2502.05167>；<https://github.com/adobe-research/NoLiMa>。

- 13 个宣称 ≥128K 的主流模型；任务是非词法关联检索（needle 与 question 几乎无字面重叠，需潜在联想）。
- **定量**：短上下文（<1K）表现好；**32K 时 11/13 个模型跌破其短文本基线的 50%**；最好的 GPT-4o 也从 99.3% 掉到 69.7%。
- 任务类型：大海捞针变体（更难）。结论只适用于"无字面匹配的检索"，比 Chroma 的任务更极端。

### 2.4 Lost in the Middle（Liu et al.，TACL 2024）

来源：*Lost in the Middle: How Language Models Use Long Contexts*, Liu, Lin, Hewitt, Paranjape, Bevilacqua, Petroni, Liang, arXiv:2307.03172（2023-07），TACL 2024，<https://arxiv.org/abs/2307.03172>。

- 任务：多文档 QA（20 文档级）+ 合成 key-value 检索。
- 结论（定性，一手摘要与正文）：性能呈 **U 形**——相关信息在开头或结尾最好，中间最差；GPT-3.5-Turbo 在 20 文档设置下中间位置的性能**低于 closed-book（完全不给文档）**。2023 年模型，主要价值是确立"位置敏感"现象。

### 2.5 反向证据：退化不只是检索失败

*Context Length Alone Hurts LLM Performance Despite Perfect Retrieval*（Findings of EMNLP 2025）：<https://aclanthology.org/anthology-files/pdf/findings/2025.findings-emnlp.1264.pdf>。即使检索完美，单纯的长输入本身也损害推理表现。这否定了一种过于乐观的假设（"只要不依赖大海捞针，长窗口就无代价"），是 footer 偏保守方向上最有力的学术依据之一。

## 3. Agent 循环对长上下文的容忍度

**没有找到"agent 任务在 X% 填充率下失效"的对照实验（未验证存在此类研究）**。间接证据：

- **LangWatch "Finding the Optimal Context Window for Coding Agents"**（<https://langwatch.ai/research/finding-the-optimal-context-window>，博客版 *The Context Tax* <https://langwatch.ai/blog/context-tax-when-to-compact>）。观察性研究：一名工程师 162 天（2026-01-18 ~ 2026-08-01）的真实 coding agent 全量 trace，287,748 次 API 调用、2,451 个 agent/thread、873 次 compaction、201 步人工审计、700 份 transcript 的 128,853 条观测：
  - **只有 14%（28/195）的步真正需要逐字引用老上下文**；按任务拆分：building / code understanding / QA 约 18–20%，**驾驶 PR 仅 2%**。其余步骤只依赖近期上下文——这正是 agent 循环（system prompt + 近期对话 + 工具结果）的画像。
  - **活跃上下文大小与窗口无关**：窗口中位数从 38,886 涨到 644,962（16.6×），实际活跃 token 仅从 7,949 到 8,452（基本持平）。
  - 成本模型最优 compaction 点 **220k**（170k–316k 在最优 10% 内）；文件引用覆盖率峰值 **240k**；按任务推荐 **200k–450k**（驾驶 PR 200–250k，研究 250–300k，QA 250–350k，building/理解 300–450k）；**>600k "unjustified premium"**，把 1M 填满比 220k 就 compact 贵 2.3×。
  - 但 compaction 本身有代价："post-compaction fog"——compaction 后 5 步内用户修正率 41.9% vs 基线 17.7%（2.37×），≥30 步才部分恢复；建议保留 30k–60k verbatim 尾巴（pi 的 `keepRecentTokens: 20000` 同思路）。
  - 局限：n=1 从业者、观察性、以成本为主轴；其 250k–450k 建议是**成本最优区间**，不是质量悬崖。
- **OpenAI GPT-4.1 Prompting Guide**（2025-04，<https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide> / [cookbook 源文件](https://github.com/openai/openai-cookbook/blob/2ccacf27/examples/gpt4-1_prompting_guide.ipynb)）一手原话："We observe very good performance on needle-in-a-haystack evaluations up to our full 1M token context, and we've observed very strong performance at complex tasks with a mix of both relevant and irrelevant code and other documents. However, long context performance can degrade as more items are required to be retrieved, or perform complex reasoning that requires knowledge of the state of the entire context."——官方口径：满窗口下检索类 OK，退化集中在"多目标检索/全局状态推理"。
- **Anthropic《Effective context engineering for AI agents》**（2025-09，<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>）：把上下文定义为 agent 的有限资源，引用 context rot，主推 compaction / note-taking / sub-agent 隔离。没有给百分比。
- **Cursor**：官方博客《Training Composer for longer horizons》（<https://cursor.com/blog/self-summarization>）承认 "agent trajectories are expanding faster than the context length of models"，用 self-summarization 训练模型跨窗口工作。论坛员工回复称后台 auto-summarization 约在窗口 **90%** 触发（服务端固定、不可配置；<https://forum.cursor.com/t/auto-summarization-triggers-too-late-model-quality-degrades-long-before-the-context-limit-context-rot/166182>，非正式文档，未验证精确值）。

## 4. 官方最佳实践：没有人说"用到窗口的百分之几"

- **OpenAI**：官方文档没有"应使用窗口的 X%"的建议。相关官方表述：超长对话"more likely to receive incomplete replies"（Advanced usage，<https://developers.openai.com/api/docs/guides/advanced-usage>）；GPT-4.1 guide 建议长上下文时指令放开头+结尾；2025 年末 Responses API 新增**服务端 compaction**（`context_management.compact_threshold`，<https://developers.openai.com/api/docs/guides/compaction>），默认阈值未见官方数值（未验证）。
- **Anthropic**：无百分比。Prompting best practices：20k+ tokens 的输入要注意结构、长文档放顶部、**查询放末尾可提升响应质量至多 30%**（<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>）；Context windows 文档把（服务端）compaction 列为长会话首选策略（<https://platform.claude.com/docs/en/build-with-claude/context-windows>）；官方博客明确引用 context rot 概念。
- **Google Gemini**：无百分比。Long context 文档建议 query 放末尾、称模型在 1M 内"up to 99% accuracy"提取信息（<https://ai.google.dev/gemini-api/docs/long-context>）。
- **结论**：三家的官方文档都只给"结构性"建议（放哪里、怎么切、何时压缩），没有给"填充率红线"。footer 的 65%/450k 没有任何官方百分比背书，依据只能落在 §2/§3 的研究和 §3 的工程实践上。

## 5. 超限时的实际行为（硬边界）

pi 依赖的 `@earendil-works/pi-ai` 在 `dist/utils/overflow.js` 里维护了一张一手整理的各提供商超限行为表（源码注释，<https://github.com/earendil-works/pi-ai> 之 `utils/overflow.js`，本地副本 `node_modules/@earendil-works/pi-ai/dist/utils/overflow.js`），与各家官方文档一致：

| 提供商 | 超限行为 |
|---|---|
| Anthropic | 400 `invalid_request_error`："prompt is too long: X tokens > Y maximum"；字节超限 413 `request_too_large` |
| OpenAI | 400："Your input exceeds the context window of this model" / "exceeds the model's maximum context length of X tokens" |
| Google Gemini | 400 `INVALID_ARGUMENT`："The input token count (X) exceeds the maximum number of tokens allowed (Y)"（官方错误格式，另见社区实例 <https://github.com/googleapis/python-genai/issues/2466>） |
| xAI / Groq / Mistral / OpenRouter / Together / Cerebras / DashScope(Qwen) / GitHub Copilot / Kimi 等 | 显式 400/413 错误（各自文案见 overflow.js 注释） |
| z.ai | **静默接受超限**（靠 usage.input > contextWindow 检出） |
| Xiaomi MiMo | **静默截断**输入至恰好填满窗口，返回 stop_reason="length"、output=0 |
| Ollama / llama.cpp / LM Studio | 视部署而定：部分显式报错，部分静默截断 |

即：**主流托管 API 报错不截断；静默截断集中在部分 OpenAI 兼容网关和本地推理后端**。Agent 框架的 compaction 触发点（工程实践）：

| 框架 | 触发点（一手来源） | 200K 窗口 | 1M 窗口 |
|---|---|---|---|
| **pi** | `contextTokens > contextWindow − 16384`（`compaction.js` `DEFAULT_COMPACTION_SETTINGS`） | 183,808（92%） | 983,616（98.4%） |
| **Claude Code** | `window − min(maxOutput, 20_000) − 13_000`；另有 blocking limit `window − 20_000 − 3_000`（`src/services/compact/autoCompact.ts`） | 167,000（83.5%） | 967,000（96.7%） |
| Cursor | ~90%（论坛员工回复，服务端固定，未验证精确值） | ~180k | ~900k |

Claude Code 的 20,000 来自官方注释："Based on p99.99 of compact summary output being 17,387 tokens"（[autoCompact.ts 源码](https://github.com/openonion/claude-code/blob/main/src/services/compact/autoCompact.ts)，反编译镜像仓库）。另有用户报告（GitHub issue #40757，<https://github.com/anthropics/claude-code/issues/40757>）订阅版 Opus 1M 在 ~420K 触发 auto-compact——与上述公式不符，疑与订阅计划的窗口注册值有关，个案报告，未验证。

**这组数字是"agent 循环可以容忍很高填充率"的最强工程证据**：Claude Code 敢把 200K 会话用到 83.5%、把 1M 会话用到 96.7% 才压缩，且这是 Anthropic 自家产品的默认行为。

## 6. 本仓库直接对照（本地源码查证，无需联网）

以下均已在 `node_modules/@earendil-works/pi-coding-agent/`（及 `@earendil-works/pi-ai`）本地源码中核实：

- **compaction 触发**：`dist/core/compaction/compaction.js` —
  `DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`（L74-78）；
  `shouldCompact(): return contextTokens > contextWindow - settings.reserveTokens`（L161-164）。
  可被 `settings.json` 的 `compaction.reserveTokens` 覆盖（`dist/core/settings-manager.js` L518）。
- **两条触发路径**：`dist/core/agent-session.js` `_checkCompaction()`（L1502-1545）：① overflow 恢复——API 报超限或被截断的 length-stop，移除该 assistant 消息、compact 后**自动重试一次**；② threshold——`shouldCompact` 命中后 compact，**不自动重试**。
- **摘要预算**：`generateSummaryWithUsage()` 的 maxTokens = `min(0.8 × 16384 ≈ 13k, model.maxTokens)`（compaction.js L461）；压缩后保留最近 `keepRecentTokens = 20000` tokens。
- **超限检测**：`@earendil-works/pi-ai/dist/utils/overflow.js` 的 `isContextOverflow()`：错误消息正则 + z.ai 式静默超限（usage.input > window）+ MiMo 式静默截断（length-stop + 零输出 + 输入≈窗口）。
- **footer 是纯显示层**：`extensions/tc-footer.ts` — `EFFECTIVE_CONTEXT_TOKENS = 450_000`（L84）；`thresholds()` 对被截断窗口 `red = 65`，未截断窗口 `red = (window − 16384)/window × 100`（L96-99）；`effectivePercent()` 分母取 `min(contextWindow, 450_000)`（L102-106）。它只读 usage 数据做渲染，不参与任何会话机制。
- **结论**：本仓库 footer 的 450k/65% 与 pi 的机制完全解耦；"略超 450k 还能跑"是必然，且对 1M 模型而言真实占用可能才 ~45%。红线对齐 pi compaction 触发点的部分（未截断窗口）与机制精确一致。

## 7. 对 footer 阈值的启示

**450k 显示上限（EFFECTIVE_CONTEXT_TOKENS）**
- 依据充分度：**中等**。它落在 LangWatch 按任务推荐的 compaction 区间上沿（building/理解 300–450k），且 "Smart Zone" 的定位（质量持有区）与 LangWatch ">600k 不合理" 的结论相容。但注意 LangWatch 是 n=1 观察性研究、主轴是成本；质量退化研究（Chroma/RULER/NoLiMa）从未给出"450k"或任何具体 token 数。
- 是否过于保守：**作为"红线"是偏保守的，作为"提醒区"是合理的**。同类生产系统的实际行为（Claude Code 1M→96.7% 才压缩、Cursor ~90%、pi 98.4%）表明 agent 会话可以跑到远超 45%（450k/1M）而机制正常。用户实测与此一致。
- 关键区别在于 footer 想表达什么：如果 450k 是"建议开始控制上下文增长"（compaction 在这个量级对**成本**有明确收益，且压缩后雾区代价尚可接受），450k 站得住；如果被读成"超过会出质量问题"，则没有任何研究支持 450k 是质量悬崖。

**65% 红线（被截断窗口 ≈ 292,500 tokens）**
- 依据充分度：**弱（作为质量悬崖）/ 合理（作为提前示警）**。292.5k 恰在 LangWatch 推荐区间的中段，工程上有依据；但"65%"这个百分比没有任何来源给出——Chroma 明确未给统一阈值，RULER 的 85.6% 是任意参照基准（且语义完全不同：性能保持率，不是填充率）。65% 的真实作用是把"黄→红"过渡提前，让用户在 Smart Zone 内就有视觉预警。
- 方向性权衡：Chroma 提醒"真实任务比实验任务更复杂，退化可能更严重"（支持保守）；LangWatch 的 14%/2% verbatim 依赖 + 活跃上下文平坦（支持宽松）；EMNLP 2025 完美检索仍退化（支持保守）；OpenAI 官方"满窗口检索性能很好"（支持宽松）。证据势均力敌，65% 是一个不坏的折中。
- 若要调整：相比挪动 65%，更有依据的改法是给 1M 窗口放宽上限（LangWatch 的">600k 不合理"对应 60%；Claude Code 用 96.7%——两者相差近一倍，说明这个量级的"最优"高度依赖任务和成本函数），或在 UI 文案上明确 450k 是"经济/质量混合参考线"而非硬限制。

**总结回答核心疑问**："多大比例的标称窗口实际可用"——机制上：直到 `窗口 − 16384`（pi）或 `窗口 − 33k`（Claude Code）都可用，1M 模型即 ~96–98%；质量上：检索/复述型任务退化可远早于此（NoLiMa 显示 32K 就很糟），但 agent 循环执行主要由近期上下文驱动，没有证据表明在 45–65% 填充率附近存在质量悬崖。450k/65% 是合理的"提醒线"，不是科学阈值；用户"略超 450k 没问题"的实测与全部机制和工程证据一致。

## 未验证事项清单

- Chroma 报告的逐模型退化百分比（原文以图片形式呈现，未 OCR 核对）；二手来源（particula.tech、flowverify.co 等）声称的"30%+""1k token 起退化"数字。
- Cursor auto-summarization 的精确触发比例（~90% 来自论坛员工回复，非官方文档）。
- OpenAI Responses API 服务端 compaction 的默认 `compact_threshold` 值。
- Claude Code 订阅版在 1M Opus 上 ~420K 触发的成因（issue #40757 个案）。
- "agent 任务在 X% 填充率下失效"的对照实验——未找到，可能不存在。
