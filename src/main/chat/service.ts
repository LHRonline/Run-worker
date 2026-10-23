/**
 * Run worker — 对话服务：一次 run 的完整生命周期
 * 入参立即返回 runId，之后全部通过 EVT.run 流式推送，结束时落库。
 */
import type {
  AgentId,
  AgentTraceStep,
  ChatMessage,
  ChatSendRequest,
  Citation,
  Conversation,
  ProviderConfig,
  RunEvent,
  Settings,
  ToolCallRecord,
  UsageStats,
} from '../../shared/types';
import { DEFAULT_USAGE } from '../../shared/types';
import { EVT } from '../../shared/ipc';
import { completeText } from '../llm/client';
import type { LlmMessage, LlmTarget, RawUsage } from '../llm/client';
import { buildSystemPrompt, buildUtilityPrompt } from '../llm/prompts';
import { chineseRatio, needsRewrite, rewriteThinkingToChinese } from '../llm/chinese';
import { estimateCostCny } from '../llm/pricing';
import { agentDescriptor, agentRuntime } from '../agents/registry';
import { routeTask, ruleRoutePublic, runAgentLoop } from '../agents/orchestrator';
import { attachmentsToParts, conversationToMessages, makeSummaryMessage, planCompression, renderForSummary, SUMMARY_SYSTEM } from './history';
import { streamDemoReply } from './demo';
import type { MainContext } from './context';
import { makeToolRuntime } from './context';

interface ActiveRun {
  runId: string;
  conversationId: string;
  controller: AbortController;
  startedAt: number;
}

interface ResolvedTarget {
  target: LlmTarget | null;
  provider: ProviderConfig | null;
  reason: string;
}

const MEMORY_SYSTEM = [
  '从这轮对话中抽取值得长期记住的信息，最多 3 条。',
  '只抽：用户稳定的偏好（工具、语言、风格）、关于用户或项目的事实、明确的长期指令。',
  '不要抽：一次性的任务内容、助手说过的话、可以随时再问到的信息。',
  '没有可记的就返回空数组。只输出 JSON：{"facts":[{"text":"...","kind":"preference|fact|project|instruction","weight":0.6}]}',
].join('\n');

export class ChatService {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly ctx: MainContext) {}

  /* ------------------------------ 对外 API ------------------------------ */

  /** 立即返回，后台执行 */
  send(req: ChatSendRequest): { runId: string; conversationId: string } {
    const settings = this.ctx.settings();
    const conv = this.ensureConversation(req, settings);
    const runId = this.newRunId();
    const controller = new AbortController();
    this.runs.set(runId, { runId, conversationId: conv.id, controller, startedAt: Date.now() });

    void this.execute(runId, req, conv, controller).catch((err) => {
      this.ctx.log.error('[chat] run 未捕获异常', err);
    }).finally(() => {
      this.runs.delete(runId);
    });

    return { runId, conversationId: conv.id };
  }

  /** 定时任务调用：等待完整结果 */
  async runForScheduler(
    prompt: string,
    opts?: { agentId?: AgentId; title?: string; source?: string },
  ): Promise<{ text: string; conversationId: string }> {
    const conv = this.ctx.store.createConversation(opts?.title ?? prompt.slice(0, 30), opts?.agentId ?? 'orchestrator');
    const runId = this.newRunId();
    const controller = new AbortController();
    this.runs.set(runId, { runId, conversationId: conv.id, controller, startedAt: Date.now() });
    try {
      const result = await this.execute(
        runId,
        { conversationId: conv.id, text: prompt, agentId: opts?.agentId },
        conv,
        controller,
      );
      return { text: result.text, conversationId: conv.id };
    } finally {
      this.runs.delete(runId);
    }
  }

  abort(runId?: string): void {
    const ids = runId ? [runId] : [...this.runs.keys()];
    for (const id of ids) {
      const run = this.runs.get(id);
      if (!run) continue;
      run.controller.abort();
      this.ctx.approval.cancelForRun(id);
    }
  }

  approve(requestId: string, approved: boolean, remember?: boolean): void {
    const hit = this.ctx.approval.resolve(requestId, approved);
    if (hit && approved && remember) {
      this.ctx.log.info('[chat] 用户选择记住本次授权', requestId);
    }
  }

  /** 运行中的 run 数量，供退出时等待 */
  activeCount(): number {
    return this.runs.size;
  }

  /* ---------------------------- 内部实现 ---------------------------- */

  private newRunId(): string {
    return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  private ensureConversation(req: ChatSendRequest, settings: Settings): Conversation {
    if (req.conversationId) {
      const found = this.ctx.store.getConversation(req.conversationId);
      if (found) return found;
    }
    return this.ctx.store.createConversation(undefined, req.agentId ?? 'orchestrator');
  }

  /** 挑选可用的服务商与模型 */
  private resolveTarget(settings: Settings, override?: { providerId: string; model: string }): ResolvedTarget {
    const usable = (p: ProviderConfig | undefined): p is ProviderConfig => {
      if (!p || !p.enabled) return false;
      if (!p.baseUrl.trim()) return false;
      if (p.kind === 'ollama' || p.kind === 'custom' || p.kind === 'openai-compatible') {
        return p.kind === 'ollama' ? true : !!p.apiKey.trim();
      }
      return !!p.apiKey.trim();
    };

    if (override?.providerId) {
      const p = settings.providers.find((x) => x.id === override.providerId);
      if (usable(p)) {
        return {
          provider: p,
          target: { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: override.model || p.models[0] || '', kind: p.kind },
          reason: '使用指定模型',
        };
      }
    }

    const active = settings.providers.find((p) => p.id === settings.activeProviderId);
    const pick = (() => {
      if (settings.freeMode) {
        const free = settings.providers.filter((p) => usable(p) && (p.free || p.kind === 'ollama'));
        if (free.length > 0) return free[0];
      }
      if (usable(active)) return active;
      return settings.providers.find((p) => usable(p)) ?? null;
    })();

    if (!pick) {
      return { target: null, provider: null, reason: '没有可用的服务商（缺少 API Key）' };
    }
    const model = pick.id === settings.activeProviderId && settings.activeModel
      ? settings.activeModel
      : pick.models[0] ?? settings.activeModel;
    if (!model) {
      return { target: null, provider: pick, reason: `服务商「${pick.name}」还没有选择模型` };
    }
    return {
      provider: pick,
      target: { providerId: pick.id, baseUrl: pick.baseUrl, apiKey: pick.apiKey, model, kind: pick.kind },
      reason: settings.freeMode ? '免费优先模式' : '使用当前选中的服务商',
    };
  }

  private usageFrom(model: string, usages: RawUsage[]): UsageStats {
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cachedTokens = 0;
    let totalTokens = 0;
    for (const u of usages) {
      promptTokens += u.prompt_tokens ?? 0;
      completionTokens += u.completion_tokens ?? 0;
      reasoningTokens += u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0;
      cachedTokens += u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      totalTokens += u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
    }
    if (totalTokens === 0) totalTokens = promptTokens + completionTokens;
    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      totalTokens,
      costCny: estimateCostCny(model, promptTokens, completionTokens, cachedTokens),
    };
  }

  private systemPrompt(settings: Settings, agent: AgentId, knowledge: string): string {
    const memoryDigest = settings.memory.enabled && settings.memory.longTerm ? this.ctx.memory.digest(1000) : '';
    const base = buildSystemPrompt({
      persona: settings.persona,
      agent: agentDescriptor(agent),
      duty: agentRuntime(agent).duty,
      memory: memoryDigest,
      knowledge,
      workspaceDir: this.ctx.workspace(),
      toolsEnabled: true,
      thinking: settings.thinking.enabled,
    });
    // 关闭前缀缓存优化时才插入易变内容，避免破坏缓存命中
    if (!settings.tokenSave.cacheFriendlyPrefix) {
      return `${base}\n\n当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    }
    return base;
  }

  /** 合并本次请求的临时覆盖项 */
  private effectiveSettings(base: Settings, overrides?: ChatSendRequest['overrides']): Settings {
    if (!overrides) return base;
    let next = base;
    if (overrides.personaPreset) {
      next = { ...next, persona: { ...next.persona, preset: overrides.personaPreset } };
    }
    if (typeof overrides.tokenSave === 'boolean') {
      next = { ...next, tokenSave: { ...next.tokenSave, enabled: overrides.tokenSave } };
    }
    return next;
  }

  /** 一次 run 的主体 */
  private async execute(
    runId: string,
    req: ChatSendRequest,
    conv: Conversation,
    controller: AbortController,
  ): Promise<{ text: string; conversationId: string }> {
    const settings = this.effectiveSettings(this.ctx.settings(), req.overrides);
    const thinkingVisible = settings.thinking.enabled;
    const signal = controller.signal;
    const citations: Citation[] = [];
    const emitRun = (event: RunEvent) => {
      if (event.type === 'run:citation') {
        for (const c of event.citations) {
          if (!citations.some((x) => x.sourcePath === c.sourcePath && x.title === c.title)) citations.push(c);
        }
      }
      this.ctx.emit(EVT.run, event);
    };
    const notify = (level: 'info' | 'warn' | 'error', text: string) =>
      emitRun({ type: 'run:notice', runId, level, text });

    // 手动指定优先：本次请求显式给了 agentId，或会话基线已是某个子 Agent，都不再覆盖用户选择。
    // 唯一例外是「总调度」——它本身就是路由器，选它等价于自动分派。
    const requestedAgent: AgentId = req.agentId ?? conv.agentId ?? 'orchestrator';
    const manual =
      requestedAgent !== 'orchestrator' && (Boolean(req.agentId) || conv.agentId !== 'orchestrator');
    let agent: AgentId = requestedAgent;
    // conv.agentId 只记「用户为会话选定的基线 Agent」，自动路由不回写
    if (manual && conv.agentId !== requestedAgent) conv.agentId = requestedAgent;
    const resolved = this.resolveTarget(settings, req.overrides?.model);
    const modelName = resolved.target?.model ?? '演示模式';

    emitRun({
      type: 'run:start',
      runId,
      conversationId: conv.id,
      agentId: agent,
      model: modelName,
      at: Date.now(),
    });

    const trace: AgentTraceStep[] = [];
    const userMessage: ChatMessage = {
      id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: req.text,
      createdAt: Date.now(),
      attachments: req.attachments,
      status: 'done',
    };

    // 1) 先做历史压缩与历史还原（不含本条新消息）
    let summaryForHistory: string | undefined = conv.summary;
    if (resolved.target && settings.tokenSave.enabled) {
      const plan = planCompression(conv.messages, settings.tokenSave.compressThreshold);
      if (plan) {
        try {
          const older = conv.summary ? `【已有摘要】${conv.summary}\n\n` : '';
          const digest = await completeText(
            resolved.target,
            `${older}${renderForSummary(plan.older)}`,
            { system: SUMMARY_SYSTEM, maxTokens: 600, temperature: 0.2, signal, timeoutMs: 40_000 },
          );
          if (digest.trim()) {
            conv.summary = digest.trim();
            summaryForHistory = conv.summary;
            conv.messages = [makeSummaryMessage(conv.summary), ...plan.recent];
            notify('info', '历史对话已压缩为摘要，以节省 token。');
          }
        } catch {
          // 摘要失败不影响主流程
        }
      }
    }

    const history = conversationToMessages(conv, {
      maxHistoryMessages: settings.tokenSave.enabled ? settings.tokenSave.maxHistoryMessages : 200,
      skipReasoningResend: settings.tokenSave.skipReasoningResend,
      summary: summaryForHistory,
    });

    // 2) 知识库预检索
    let kbContext = '';
    let kbCitations: Citation[] = [];
    try {
      if (this.ctx.kb.stats().sources > 0) {
        const hits = await this.ctx.kb.search(req.text.slice(0, 400), 5);
        if (hits.length > 0) {
          kbContext = hits
            .map((h, i) => `[${i + 1}] ${h.title}（${h.path}）\n${h.snippet.trim()}`)
            .join('\n\n');
          kbCitations = hits.map((h) => ({
            title: h.title,
            sourcePath: h.path,
            snippet: h.snippet.slice(0, 300),
            score: h.score,
          }));
        }
      }
    } catch (err) {
      this.ctx.log.warn('[chat] 知识库检索失败', err);
    }

    // 3) 落用户消息
    conv.messages.push(userMessage);
    if (conv.title === '新对话' || !conv.title.trim()) conv.title = deriveTitleSafe(req.text);
    this.ctx.store.saveConversation(conv);

    /* ---------------------------- 演示模式 ---------------------------- */
    if (!resolved.target) {
      // 演示模式与真实路径同构：手动指定 / 自动路由 / 路由判定三态都写入 trace
      if (manual) {
        trace.push({
          id: `tr_${Date.now().toString(36)}`,
          agentId: agent,
          action: '手动指定',
          detail: '用户已指定 Agent，跳过自动路由',
          at: Date.now(),
        });
      } else if (agent === 'orchestrator' && settings.agent.autoDelegate) {
        const decision = ruleRoutePublic(req.text, agent, true);
        if (decision.agentId !== agent) {
          emitRun({
            type: 'run:routing',
            runId,
            from: agent,
            to: decision.agentId,
            reason: '按任务关键词匹配',
          });
          trace.push({
            id: `tr_${Date.now().toString(36)}`,
            agentId: decision.agentId,
            action: '自动路由',
            detail: `${agent} → ${decision.agentId}：按任务关键词匹配`,
            at: Date.now(),
          });
          agent = decision.agentId;
        } else {
          trace.push({
            id: `tr_${Date.now().toString(36)}`,
            agentId: agent,
            action: '路由判定',
            detail: `保持 ${agent}：未命中任何子 Agent 关键词`,
            at: Date.now(),
          });
        }
      }
      notify('info', '未配置可用的模型 API Key，已进入演示模式。');
      let demoText = '';
      let demoThinking = '';
      try {
        const demo = await streamDemoReply({
          text: req.text,
          agentId: agent,
          settings,
          signal,
          onThinking: (delta) => {
            demoThinking += delta;
            if (thinkingVisible) emitRun({ type: 'run:thinking', runId, delta });
          },
          onDelta: (delta) => emitRun({ type: 'run:content', runId, delta }),
        });
        demoText = demo.text;
        if (!demoThinking) demoThinking = demo.thinking;
      } catch (err) {
        this.ctx.log.error('[chat] 演示模式生成失败', err);
      }
      const demoMsg: ChatMessage = {
        id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: demoText,
        thinking: thinkingVisible && demoThinking ? demoThinking : undefined,
        createdAt: Date.now(),
        agentId: agent,
        model: '演示模式',
        status: signal.aborted ? 'aborted' : 'done',
      };
      conv.messages.push(demoMsg);
      conv.trace = [...(conv.trace ?? []), ...trace].slice(-200);
      const convUsage = this.ctx.store.saveConversation(conv).usage ?? { ...DEFAULT_USAGE };
      emitRun({ type: 'run:usage', runId, usage: { ...DEFAULT_USAGE }, conversationUsage: convUsage });
      emitRun({ type: 'run:end', runId, status: signal.aborted ? 'aborted' : 'done', messageId: demoMsg.id });
      return { text: demoText, conversationId: conv.id };
    }

    const target = resolved.target;

    /* ----------------------------- 路由 ----------------------------- */
    if (manual) {
      // 手动模式不发 run:routing：UI 已有当前 Agent 徽章，避免「总调度→总调度」噪音
      trace.push({
        id: `tr_${Date.now().toString(36)}`,
        agentId: agent,
        action: '手动指定',
        detail: '用户已指定 Agent，跳过自动路由',
        at: Date.now(),
      });
    } else if (settings.agent.autoDelegate) {
      try {
        const decision = await routeTask({
          text: req.text,
          current: agent,
          settings,
          target,
          signal,
        });
        if (decision.agentId !== agent) {
          const from = agent;
          emitRun({ type: 'run:routing', runId, from, to: decision.agentId, reason: decision.reason });
          trace.push({
            id: `tr_${Date.now().toString(36)}`,
            agentId: decision.agentId,
            action: '自动路由',
            detail: `${from} → ${decision.agentId}：${decision.reason}`,
            at: Date.now(),
          });
          // 只改本轮执行者，不回写 conv.agentId（会话基线仍是总调度，下次还能重新分派）
          agent = decision.agentId;
        } else {
          trace.push({
            id: `tr_${Date.now().toString(36)}`,
            agentId: agent,
            action: '路由判定',
            detail: `保持 ${agent}：${decision.reason}`,
            at: Date.now(),
          });
        }
      } catch (err) {
        this.ctx.log.warn('[chat] 路由失败，沿用当前 Agent', err);
      }
    }

    /* ---------------------------- 主循环 ---------------------------- */
    const messages: LlmMessage[] = [{ role: 'system', content: this.systemPrompt(settings, agent, kbContext) }, ...history];
    const userParts = attachmentsToParts(req.attachments);
    messages.push(
      userParts.length > 0
        ? { role: 'user', content: [{ type: 'text', text: req.text }, ...userParts] }
        : { role: 'user', content: req.text },
    );

    let content = '';
    let thinking = '';
    let toolCalls: ToolCallRecord[] = [];
    let usages: RawUsage[] = [];
    const rt = makeToolRuntime(this.ctx, runId, notify);

    try {
      const result = await runAgentLoop({
        target,
        agent,
        messages,
        maxSteps: settings.agent.maxSteps,
        temperature: settings.persona.temperature,
        maxOutputTokens: settings.tokenSave.maxOutputTokens,
        toolsEnabled: true,
        toolOutputLimit: settings.tokenSave.toolOutputLimit,
        signal,
        deps: { runId, rt, emitRun },
        onDelta: (delta) => emitRun({ type: 'run:content', runId, delta }),
        onReasoning: (delta) => {
          if (thinkingVisible) emitRun({ type: 'run:thinking', runId, delta });
        },
      });
      content = result.text;
      thinking = thinkingVisible ? result.reasoning : '';
      toolCalls = result.toolCalls;
      usages = result.usages;

      for (const t of toolCalls.filter((c) => c.status === 'done')) {
        trace.push({
          id: `tr_${t.id}`,
          agentId: agent,
          action: `工具 ${t.name}`,
          detail: t.result?.slice(0, 160),
          at: t.startedAt ?? Date.now(),
        });
      }
    } catch (err) {
      const aborted = signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      if (!aborted) this.ctx.log.error('[chat] 模型调用失败', err);

      const failMsg: ChatMessage = {
        id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: content || (aborted ? '（已停止生成）' : ''),
        thinking: thinking || undefined,
        createdAt: Date.now(),
        agentId: agent,
        model: target.model,
        providerId: target.providerId,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        status: aborted ? 'aborted' : 'error',
        error: aborted ? undefined : message,
      };
      conv.messages.push(failMsg);
      this.ctx.store.saveConversation(conv);
      if (!aborted) notify('error', message);
      emitRun({
        type: 'run:end',
        runId,
        status: aborted ? 'aborted' : 'error',
        messageId: failMsg.id,
        error: aborted ? undefined : message,
      });
      return { text: content, conversationId: conv.id };
    }

    /* ------------------------- 思考语言治理 ------------------------- */
    if (thinking && settings.thinking.forceChinese) {
      const ratio = chineseRatio(thinking);
      if (needsRewrite(thinking, settings.thinking.chineseRatioThreshold)) {
        const rewritten = await rewriteThinkingToChinese(
          thinking,
          {
            complete: async (input, o) =>
              completeText(target, input, {
                system: o?.system,
                maxTokens: o?.maxTokens ?? 1200,
                temperature: 0.2,
                signal: o?.signal,
                timeoutMs: 25_000,
              }),
          },
          {
            threshold: settings.thinking.chineseRatioThreshold,
            signal,
            onEvent: (info) => {
              if (info.rewritten) {
                emitRun({ type: 'run:thinking-lang', runId, ratio: info.ratio, rewritten: true });
              } else {
                emitRun({ type: 'run:thinking-lang', runId, ratio: info.ratio, rewritten: false });
              }
            },
          },
        );
        if (rewritten.rewritten) thinking = rewritten.text;
        else if (rewritten.failed) {
          thinking = rewritten.text;
          notify('warn', '思考内容未能自动转为中文，已保留原文。');
        }
      } else {
        emitRun({ type: 'run:thinking-lang', runId, ratio, rewritten: false });
      }
    }

    /* ---------------------------- 落库 ---------------------------- */
    const usage = this.usageFrom(target.model, usages);
    const allCitations = [...kbCitations, ...citations];
    const assistant: ChatMessage = {
      id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      content: content || '（模型没有返回内容，可以换个说法再试一次）',
      thinking: thinking || undefined,
      createdAt: Date.now(),
      agentId: agent,
      model: target.model,
      providerId: target.providerId,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      citations: allCitations.length > 0 ? dedupeCitations(allCitations) : undefined,
      status: signal.aborted ? 'aborted' : 'done',
    };
    conv.messages.push(assistant);
    conv.trace = [...(conv.trace ?? []), ...trace].slice(-200);
    const saved = this.ctx.store.saveConversation(conv);

    if (assistant.citations && assistant.citations.length > 0) {
      emitRun({ type: 'run:citation', runId, citations: assistant.citations });
    }
    emitRun({ type: 'run:usage', runId, usage, conversationUsage: saved.usage ?? { ...DEFAULT_USAGE } });

    const budget = settings.tokenSave.budgetAlertCny;
    if (budget > 0 && (saved.usage?.costCny ?? 0) > budget) {
      notify('warn', `本对话累计成本约 ¥${(saved.usage?.costCny ?? 0).toFixed(2)}，已超过预算提醒线 ¥${budget}。`);
    }

    emitRun({ type: 'run:end', runId, status: signal.aborted ? 'aborted' : 'done', messageId: assistant.id });

    /* ------------------------- 长期记忆抽取 ------------------------- */
    if (settings.memory.enabled && settings.memory.longTerm && settings.memory.autoExtract && !signal.aborted) {
      void this.extractMemory(target, req.text, content).catch((err) => {
        this.ctx.log.warn('[chat] 记忆抽取失败（已忽略）', err);
      });
    }

    return { text: content, conversationId: conv.id };
  }

  /** 用一次轻量调用抽取 0-3 条长期记忆 */
  private async extractMemory(target: LlmTarget, question: string, answer: string): Promise<void> {
    if (!question.trim() || !answer.trim()) return;
    const raw = await completeText(
      target,
      `用户：${question.slice(0, 800)}\n\n助手：${answer.slice(0, 1200)}`,
      { system: buildUtilityPrompt(MEMORY_SYSTEM), maxTokens: 300, temperature: 0, json: true, timeoutMs: 20_000 },
    );
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return;
    let parsed: { facts?: Array<{ text?: string; kind?: string; weight?: number }> };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
    } catch {
      return;
    }
    const facts = (parsed.facts ?? []).filter((f) => typeof f.text === 'string' && f.text.trim().length >= 4).slice(0, 3);
    for (const f of facts) {
      const kind = ['preference', 'fact', 'project', 'instruction'].includes(f.kind ?? '')
        ? (f.kind as 'preference' | 'fact' | 'project' | 'instruction')
        : 'fact';
      this.ctx.memory.add({
        text: (f.text ?? '').trim().slice(0, 200),
        kind,
        weight: typeof f.weight === 'number' ? Math.min(1, Math.max(0, f.weight)) : 0.55,
        source: 'auto',
      });
    }
  }
}

function dedupeCitations(list: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of list) {
    const key = `${c.sourcePath}::${c.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, 12);
}

function deriveTitleSafe(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '新对话';
  return clean.length > 30 ? `${clean.slice(0, 30)}…` : clean;
}
