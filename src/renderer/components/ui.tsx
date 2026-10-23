import { useEffect, useState, type ReactNode } from 'react';

/* -------------------------------- 开关 -------------------------------- */

export function Switch({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      title={title}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}

/* -------------------------------- 滑块 -------------------------------- */

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(v: number): void;
  format?(v: number): string;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="range-row" style={{ width: '100%' }}>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="range-value">{format ? format(value) : value}</span>
    </div>
  );
}

/* -------------------------------- 分段控制器 -------------------------------- */

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------- 字段 -------------------------------- */

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required ? <span className="req">*</span> : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/* -------------------------------- 设置行 -------------------------------- */

export function SettingRow({
  title,
  desc,
  children,
  wide,
  badge,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-row-title">
          {title}
          {badge}
        </div>
        {desc ? <div className="set-row-desc">{desc}</div> : null}
      </div>
      <div className={`set-row-ctrl${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}

/* -------------------------------- 设置卡 -------------------------------- */

export function SetCard({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="set-card">
      <div className="set-card-head">
        <span className="t">{title}</span>
        {sub ? <span className="s">{sub}</span> : null}
      </div>
      <div className="set-card-body">{children}</div>
    </div>
  );
}

/* -------------------------------- 空状态 -------------------------------- */

export function EmptyState({ icon, title, desc }: { icon: string; title: string; desc?: string }) {
  return (
    <div className="empty-state">
      <div className="ico">{icon}</div>
      <div className="t">{title}</div>
      {desc ? <div className="d">{desc}</div> : null}
    </div>
  );
}

/* -------------------------------- 复制按钮 -------------------------------- */

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="copy-mini"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => setDone(false));
      }}
    >
      {done ? '已复制' : label}
    </button>
  );
}

/* -------------------------------- 外部链接 -------------------------------- */

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClose, active]);
}
