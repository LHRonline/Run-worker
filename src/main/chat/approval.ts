/**
 * Run worker — 授权中介
 * 工具需要用户确认时挂起等待，120 秒无响应视为拒绝。
 */
import type { ApprovalRequest } from '../../shared/types';
import { EVT } from '../../shared/ipc';

interface Pending {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  request: ApprovalRequest;
}

export const APPROVAL_TIMEOUT = 120_000;

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly emit: (channel: string, payload: unknown) => void,
    private readonly timeoutMs = APPROVAL_TIMEOUT,
  ) {}

  /** 发请求给界面并等待决定 */
  request(req: Omit<ApprovalRequest, 'id'>): Promise<boolean> {
    const id = `apv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const full: ApprovalRequest = { ...req, id };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.emit(EVT.toast, { kind: 'warn', text: '授权请求超时（120 秒），已按拒绝处理。' });
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer, request: full });
      this.emit(EVT.approval, full);
    });
  }

  /** 渲染层回传决定；返回是否命中待处理项 */
  resolve(id: string, approved: boolean): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    clearTimeout(item.timer);
    this.pending.delete(id);
    item.resolve(approved);
    return true;
  }

  /** 取消某个 run 的所有待授权请求 */
  cancelForRun(runId: string): void {
    for (const [id, item] of [...this.pending.entries()]) {
      if (item.request.runId !== runId) continue;
      clearTimeout(item.timer);
      this.pending.delete(id);
      item.resolve(false);
    }
  }

  cancelAll(): void {
    for (const [id, item] of [...this.pending.entries()]) {
      clearTimeout(item.timer);
      this.pending.delete(id);
      item.resolve(false);
    }
  }
}
