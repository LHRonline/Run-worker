import { useEffect } from 'react';
import type { ToastItem } from '../state/store';

const ICON: Record<string, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '✕',
};

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss(id: string): void }) {
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss(id: string): void }) {
  useEffect(() => {
    const duration = toast.kind === 'error' ? 5200 : 3400;
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);

  return (
    <div className={`toast ${toast.kind}`}>
      <span className="ti">{ICON[toast.kind] ?? 'i'}</span>
      <span className="tx">{toast.text}</span>
      <button type="button" className="close" onClick={() => onDismiss(toast.id)} aria-label="关闭提示">
        ✕
      </button>
    </div>
  );
}
