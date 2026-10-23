import type { ReactNode } from 'react';

/* 统一的线性图标集：20×20 画布、1.5 描边、圆头端点，保证侧栏与设置导航风格一致 */
export type IconName =
  | 'agents'
  | 'tasks'
  | 'kb'
  | 'mcp'
  | 'memory'
  | 'settings'
  | 'general'
  | 'models'
  | 'free'
  | 'persona'
  | 'token'
  | 'thinking'
  | 'security'
  | 'appearance'
  | 'update'
  | 'about'
  | 'search'
  | 'plus'
  | 'close'
  | 'chevron'
  | 'pin'
  | 'trash'
  | 'edit'
  | 'history'
  | 'external'
  | 'sun'
  | 'moon'
  | 'system';

const P: Record<IconName, ReactNode> = {
  agents: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.8" />
      <rect x="11" y="3" width="6" height="6" rx="1.8" />
      <rect x="3" y="11" width="6" height="6" rx="1.8" />
      <rect x="11" y="11" width="6" height="6" rx="1.8" />
    </>
  ),
  tasks: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.2V10l2.6 1.7" />
    </>
  ),
  kb: (
    <>
      <path d="M3.6 4.4c2.1-.9 4.3-.9 6.4 0 2.1-.9 4.3-.9 6.4 0v11.2c-2.1-.9-4.3-.9-6.4 0-2.1-.9-4.3-.9-6.4 0z" />
      <path d="M10 4.4v11.2" />
    </>
  ),
  mcp: (
    <>
      <path d="M7.2 3v3.6M12.8 3v3.6" />
      <path d="M5.2 6.6h9.6v2.8a4.8 4.8 0 0 1-9.6 0z" />
      <path d="M10 14.2V17" />
    </>
  ),
  memory: (
    <>
      <path d="M10 3.2l6.4 3.5-6.4 3.5-6.4-3.5z" />
      <path d="M3.6 10.3l6.4 3.5 6.4-3.5" />
      <path d="M3.6 13.9l6.4 3.5 6.4-3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.6v2.1M10 15.3v2.1M2.6 10h2.1M15.3 10h2.1M4.8 4.8l1.5 1.5M13.7 13.7l1.5 1.5M15.2 4.8l-1.5 1.5M6.3 13.7l-1.5 1.5" />
    </>
  ),
  general: (
    <>
      <path d="M3 6.6h3.3M11.3 6.6H17M3 13.4h5.3M13.3 13.4H17" />
      <circle cx="9" cy="6.6" r="1.9" />
      <circle cx="11" cy="13.4" r="1.9" />
    </>
  ),
  models: (
    <>
      <rect x="6" y="6" width="8" height="8" rx="2" />
      <rect x="8.4" y="8.4" width="3.2" height="3.2" rx="0.8" />
      <path d="M8.8 3v3M11.2 3v3M8.8 14v3M11.2 14v3M3 8.8h3M3 11.2h3M14 8.8h3M14 11.2h3" />
    </>
  ),
  free: <path d="M11.3 2.6L5.4 11h3.9l-.8 6.4 6-8.6h-4z" />,
  persona: (
    <>
      <path d="M3.2 16.8l.8-3.4L13.4 4a1.9 1.9 0 0 1 2.7 2.7L6.6 16z" />
      <path d="M12.3 5.1l2.6 2.6" />
    </>
  ),
  token: (
    <>
      <path d="M3.2 4.6h13.6l-5.3 6.2v6.1l-3-1.9v-4.2z" />
      <path d="M6.4 7.6h7.2" />
    </>
  ),
  thinking: (
    <>
      <path d="M10 2.9a4.7 4.7 0 0 1 2.8 8.4v1.9H7.2v-1.9A4.7 4.7 0 0 1 10 2.9z" />
      <path d="M8.2 15.7h3.6M9 17.6h2" />
    </>
  ),
  security: <path d="M10 2.7L15.8 5v4.6c0 3.8-2.4 6.4-5.8 7.7-3.4-1.3-5.8-3.9-5.8-7.7V5z" />,
  appearance: (
    <>
      <path d="M10 3a7 7 0 0 0 0 14c1.4 0 2.1-.9 1.4-2-.7-1.2.2-2.2 1.5-2.2H15a3.6 3.6 0 0 0 3.6-3.6C18.6 5.6 14.8 3 10 3z" />
      <circle cx="7.2" cy="7.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="11.2" cy="6.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="6.4" cy="11.2" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  update: (
    <>
      <path d="M16.3 9.4A6.4 6.4 0 1 0 16 12.4" />
      <path d="M16.7 3.8v4.9h-4.9" />
    </>
  ),
  about: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9.2v4.4" />
      <circle cx="10" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="8.8" cy="8.8" r="5.2" />
      <path d="M12.6 12.6L17 17" />
    </>
  ),
  plus: <path d="M10 4.4v11.2M4.4 10h11.2" />,
  close: <path d="M5.6 5.6l8.8 8.8M14.4 5.6l-8.8 8.8" />,
  chevron: <path d="M7.6 5.2l4.8 4.8-4.8 4.8" />,
  pin: (
    <path d="M12.5 3.2l4.3 4.3-1.6.7-2.5-.6-3.4 3.4.7 2.5-.8 1.6-4.3-4.3 1.6-.8 2.5.7 3.4-3.4-.6-2.5z" />
  ),
  trash: (
    <>
      <path d="M3.9 6.1h12.2M8 6.1V4.2h4v1.9" />
      <path d="M6.2 6.1l.9 10.4h5.8l.9-10.4" />
    </>
  ),
  edit: (
    <>
      <path d="M3.2 16.8l.8-3.4L13.4 4a1.9 1.9 0 0 1 2.7 2.7L6.6 16z" />
      <path d="M12.3 5.1l2.6 2.6" />
    </>
  ),
  history: (
    <>
      <path d="M3.7 10a6.4 6.4 0 1 0 2-4.6" />
      <path d="M3.4 4v4.4h4.4" />
      <path d="M10 6.6V10l2.4 1.6" />
    </>
  ),
  external: (
    <>
      <path d="M12.6 3.4h4v4M16.6 3.4l-7.2 7.2" />
      <path d="M14.4 12v4.3H3.7V5.5h4.3" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.4v1.8M10 15.8v1.8M2.4 10h1.8M15.8 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3" />
    </>
  ),
  moon: <path d="M15.6 12.7A6.2 6.2 0 0 1 7.3 4.5 6.2 6.2 0 1 0 15.6 12.7z" />,
  system: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 3v14a7 7 0 0 0 0-14z" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {P[name]}
    </svg>
  );
}
