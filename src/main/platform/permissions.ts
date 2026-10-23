/**
 * 命令安全策略（PermissionGuard）
 *
 * 设计要点：
 * 1. 先按 && || ; | 换行 单独 & 拆成「段」，逐段判定后取最高风险，避免 `ls && rm -rf /` 绕过；
 * 2. 匹配前归一化（小写、压缩空白、去引号），降低大小写/空格绕过（`RM  -RF`、多空格均已覆盖）；
 * 3. denyPatterns 命中直接拒绝；
 * 4. 内置变体模式：覆盖 PowerShell 别名（ri）、rimraf、find -delete、shred、
 *    WMIC delete、.NET Delete、物理设备写入、git clean 等常见绕过写法；
 * 5. 风险等级只描述危害，是否需确认交给 approvalMode 决定。
 */
import * as path from 'node:path';
import type { CommandVerdict, PermissionGuard } from '../../shared/platform';
import type { Settings } from '../../shared/types';

type Risk = 'low' | 'medium' | 'high';

/** 高危特征：递归删除 / 注册表 / 格式化 / 关机 / 远程脚本直通 / 提权 */
const HIGH_RULES: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-{1,2}[a-z-]+\s+)*-{1,2}[a-z]*[rf][a-z]*\b/, reason: '递归或强制删除文件' },
  { re: /\brimraf\b/, reason: '递归删除目录（rimraf）' },
  { re: /\bri\s+-{1,2}[a-z]*[rf]/, reason: '递归删除（PowerShell 别名 ri）' },
  { re: /\b(rd|rmdir|erase)\s+\/[a-z]*[sq][a-z]*\b/, reason: 'Windows 递归删除目录' },
  { re: /\bdel\s+\/[a-z]*[sqf][a-z]*\b/, reason: 'Windows 静默强制删除' },
  { re: /\bremove-item\b.*-recurse/, reason: 'PowerShell 递归删除' },
  { re: /\bfind\s+\S+.*\s-delete\b/, reason: 'find -delete 批量删除文件' },
  { re: /\bshred\b/, reason: '覆写销毁文件' },
  { re: /\bgit\s+clean\s+-[a-z]*[fdx]/, reason: 'git clean 删除未跟踪文件' },
  { re: /\bwmic\b.*\bdelete\b/, reason: 'WMIC 删除（进程/服务等）' },
  { re: /system\.io\.(file|directory)\]?::\s*delete|\]\.delete\(.*true\s*\)/, reason: '通过 .NET 接口递归删除' },
  { re: /\b(rm|del|erase|remove-item|ri)\b.*(\*|\/[a-z]*\*)/, reason: '通配符批量删除' },
  { re: /\bformat(\.com)?\s+[a-z]:/, reason: '格式化磁盘' },
  { re: /\bmkfs(\.|\s)/, reason: '格式化文件系统' },
  { re: /\bdiskpart\b/, reason: '磁盘分区操作' },
  { re: /\bdd\s+if=/, reason: '裸设备写入' },
  { re: /\\\\\.\\(physicaldrive|harddiskvolume)/, reason: '写入物理磁盘设备' },
  { re: /\breg\s+(add|delete|import|restore)\b/, reason: '修改注册表' },
  { re: /\b(set|new)-itemproperty\b.*(hklm|hkcu|hkey_)/, reason: '修改注册表' },
  { re: /\bregedit\b.*(\/s|\/import)\b/, reason: '批量导入注册表' },
  { re: /\bbcdedit\b/, reason: '修改启动配置' },
  { re: /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/, reason: '关机或重启系统' },
  { re: /\blogoff\b/, reason: '注销当前用户' },
  { re: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell|cmd|iex|node|python)\b/, reason: '远程脚本直接管道执行' },
  { re: /(^|\s)(sh|bash|zsh|pwsh|powershell|cmd)\s+<\s*\(?\s*(curl|wget)\b/, reason: '远程脚本直接执行' },
  { re: /\bsudo\b/, reason: '提权执行' },
  { re: /\brunas\b|\bstart-process\b.*-verb\s+runas/, reason: '提权执行' },
  { re: /\btakeown\b|\bicacls\b.*\/grant/, reason: '修改文件所有权或权限' },
  { re: /\bchmod\s+(-[a-z]+\s+)*(777|a\+rwx)\b/, reason: '开放全部文件权限' },
  { re: /\bchown\s+-[a-z]*r/, reason: '递归修改文件所有者' },
  { re: /\bnet\s+user\b.*\/add/, reason: '创建系统账户' },
  { re: /\bnet\s+localgroup\b.*\/add/, reason: '修改用户组' },
  { re: /\b(vssadmin|wbadmin)\b.*delete/, reason: '删除系统备份' },
  { re: /\bcipher\s+\/w\b/, reason: '擦除磁盘空闲空间' },
  { re: /\b(powershell|pwsh)\b.*\s-(enc|encodedcommand)\b/, reason: '编码命令绕过检测' },
  { re: /\binvoke-expression\b|\biex\s*[(\s]/, reason: '动态执行字符串代码' },
  { re: /\bkill(all)?\b.*\s-9\b|\btaskkill\b.*\/f\b/, reason: '强制终止进程' },
  { re: />\s*\/dev\/(sd|hd|nvme|disk)/, reason: '写入裸磁盘设备' },
];

/** 中危特征：写入 / 安装 / 网络下载 / 代码执行 */
const MEDIUM_RULES: { re: RegExp; reason: string }[] = [
  { re: /(^|\s)(npm|pnpm|yarn|bun)\s+(i|in|install|add|remove|rm|uninstall|update|upgrade|publish)\b/, reason: '安装或卸载依赖' },
  { re: /\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\buv\s+(pip\s+)?(add|install)\b/, reason: '安装 Python 包' },
  { re: /\b(apt|apt-get|yum|dnf|brew|choco|winget|scoop)\s+(install|upgrade|remove|uninstall)\b/, reason: '安装系统软件包' },
  { re: /\bgit\s+(clone|push|pull|fetch|reset|checkout|merge|rebase|clean|commit|tag|stash)\b/, reason: '改动代码仓库' },
  { re: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/, reason: '网络请求或下载' },
  { re: /\b(tee|out-file|set-content|add-content)\b/, reason: '写入文件' },
  { re: /(^|[^<>])>{1,2}\s*[^&|\s]/, reason: '重定向写入文件' },
  { re: /\b(mkdir|md|new-item|touch)\b/, reason: '创建目录或文件' },
  { re: /\b(cp|copy|xcopy|robocopy|mv|move|rename|ren)\b/, reason: '移动或复制文件' },
  { re: /\b(npm|pnpm|yarn|node|npx|python|python3|py|go|cargo|dotnet|java|javac|ruby|php|tsc)\b/, reason: '执行程序或脚本' },
  { re: /\bdocker\s+(run|build|rm|exec|push)\b/, reason: '容器操作' },
  { re: /\b(kill|taskkill|stop-process)\b/, reason: '终止进程' },
  { re: /\btruncate\s+-s\s*0/, reason: '清空文件内容' },
  { re: /\b(ssh|scp|sftp|telnet|rsync)\b/, reason: '远程连接或传输' },
  { re: /\bchmod\b|\bchown\b|\bicacls\b|\battrib\b.*[+-][rhs]/, reason: '修改文件权限属性' },
  { re: /\bgit\s+config\b/, reason: '修改 Git 配置' },
];

/** 只读白名单（按「命令 + 参数前缀」匹配） */
const LOW_PREFIXES: string[] = [
  'dir', 'ls -l', 'ls -a', 'ls', 'll', 'cat', 'type', 'echo', 'pwd', 'cd', 'where', 'which', 'whoami',
  'hostname', 'date', 'time', 'ver', 'tree', 'head', 'tail', 'more', 'wc', 'sort', 'uniq',
  'findstr', 'grep', 'select-string', 'get-childitem', 'get-content', 'get-location', 'get-item',
  'get-process', 'get-date', 'get-command', 'test-path', 'resolve-path', 'measure-object',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote', 'git rev-parse', 'git blame',
  'node -v', 'node --version', 'npm -v', 'npm --version', 'npm ls', 'npm list',
  'python --version', 'python -V', 'python3 --version', 'tsc -v', 'tsc --version',
  'ipconfig', 'systeminfo', 'tasklist', 'ps', 'df', 'du', 'netstat', 'ping', 'nslookup', 'tracert',
  'code --version', 'git --version', 'docker ps', 'docker images',
];

/** 拆分命令段：&& || ; | 换行 以及单独的 & */
function splitSegments(command: string): string[] {
  return command
    .replace(/\r\n?/g, '\n')
    .split(/&&|\|\||[;|\n]|(?<!&)&(?!&)/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 归一化：小写、去引号、压缩空白 */
function normalize(command: string): string {
  return command
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 是否只读命令（含重定向一律不算） */
function isReadOnly(segment: string): boolean {
  const s = segment.trim();
  if (/>\s*\S/.test(s)) return false;
  return LOW_PREFIXES.some((p) => s === p || s.startsWith(p + ' '));
}

function matchRules(segment: string, rules: { re: RegExp; reason: string }[]): string | null {
  for (const rule of rules) {
    if (rule.re.test(segment)) return rule.reason;
  }
  return null;
}

/** 系统关键路径判定（Windows / Program Files / System32 等） */
function isInsideSystemDir(target: string): boolean {
  let p: string;
  try {
    p = path.resolve(target).toLowerCase().replace(/[\\/]+$/, '');
  } catch {
    return false;
  }
  if (/^[a-z]:\\windows(\\|$)/.test(p)) return true;
  if (/^[a-z]:\\program files( \(x86\))?(\\|$)/.test(p)) return true;
  if (/^[a-z]:\\programdata(\\|$)/.test(p)) return true;
  if (/^\/(usr|etc|bin|sbin|boot|sys|proc|lib|var)(\/|$)/.test(p)) return true;
  const envDirs = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
    process.env.ProgramData,
  ];
  for (const d of envDirs) {
    if (!d) continue;
    const base = path.resolve(d).toLowerCase().replace(/[\\/]+$/, '');
    if (p === base || p.startsWith(base + '\\') || p.startsWith(base + '/')) return true;
  }
  return false;
}

export function createPermissionGuard(settings: () => Settings): PermissionGuard {
  /** denyPatterns 命中检测（正则非法时退化为子串匹配） */
  function hitDeny(normalizedText: string): string | null {
    const patterns = settings().agent?.denyPatterns ?? [];
    for (const raw of patterns) {
      const text = String(raw ?? '').trim();
      if (!text) continue;
      try {
        if (new RegExp(text, 'i').test(normalizedText)) return text;
      } catch {
        if (normalizedText.includes(text.toLowerCase())) return text;
      }
    }
    return null;
  }

  /** 依据 approvalMode 决定是否需要确认 */
  function needApproval(risk: Risk): boolean {
    const mode = settings().agent?.approvalMode ?? 'safe-only';
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return risk !== 'low';
  }

  return {
    inspectCommand(command: string): CommandVerdict {
      const raw = String(command ?? '').trim();
      if (!raw) {
        return { allowed: true, requiresApproval: false, risk: 'low', reason: '空命令，无需执行' };
      }

      const normalized = normalize(raw);

      const denied = hitDeny(normalized);
      if (denied) {
        return {
          allowed: false,
          requiresApproval: false,
          risk: 'high',
          reason: `命中黑名单规则（${denied}），已阻止执行`,
        };
      }

      const segments = splitSegments(normalized);
      const target = segments.length > 0 ? segments : [normalized];

      // 先整体扫一遍高危特征：`curl x | sh` 这类管道语义拆分后会丢失上下文
      const wholeHigh = matchRules(normalized, HIGH_RULES);
      if (wholeHigh) {
        return {
          allowed: true,
          requiresApproval: needApproval('high'),
          risk: 'high',
          reason: `检测到高危操作：${wholeHigh}`,
        };
      }

      let risk: Risk = 'low';
      let reason = '只读命令，可直接执行';

      for (const seg of target) {
        const highReason = matchRules(seg, HIGH_RULES);
        if (highReason) {
          return {
            allowed: true,
            requiresApproval: needApproval('high'),
            risk: 'high',
            reason: `检测到高危操作：${highReason}`,
          };
        }
        if (risk === 'low') {
          const mediumReason = matchRules(seg, MEDIUM_RULES);
          if (mediumReason) {
            risk = 'medium';
            reason = `检测到写入或执行类操作：${mediumReason}`;
          } else if (!isReadOnly(seg)) {
            risk = 'medium';
            reason = '无法确认是只读命令，按写入类操作处理';
          }
        }
      }

      // 组合命令即便是只读也提升一档：管道/串联可能掩盖真实意图
      if (risk === 'low' && target.length > 1) {
        risk = 'medium';
        reason = '组合命令，按写入类操作处理';
      }

      return { allowed: true, requiresApproval: needApproval(risk), risk, reason };
    },

    inspectFileWrite(target: string): CommandVerdict {
      const raw = String(target ?? '').trim();
      if (!raw) {
        return { allowed: false, requiresApproval: false, risk: 'high', reason: '未指定写入路径' };
      }

      const denied = hitDeny(normalize(raw));
      if (denied) {
        return {
          allowed: false,
          requiresApproval: false,
          risk: 'high',
          reason: `路径命中黑名单规则（${denied}），已阻止写入`,
        };
      }

      if (isInsideSystemDir(raw)) {
        return {
          allowed: true,
          requiresApproval: needApproval('high'),
          risk: 'high',
          reason: '目标位于系统目录（Windows / Program Files / System32），写入可能破坏系统',
        };
      }

      const workspace = settings().agent?.workspaceDir ?? '';
      if (workspace) {
        let ws = '';
        let p = '';
        try {
          ws = path.resolve(workspace).toLowerCase();
          p = path.resolve(raw).toLowerCase();
        } catch {
          ws = '';
        }
        if (ws && (p === ws || p.startsWith(ws + '\\') || p.startsWith(ws + '/'))) {
          return {
            allowed: true,
            requiresApproval: needApproval('low'),
            risk: 'low',
            reason: '写入工作目录内的普通文件',
          };
        }
      }

      return {
        allowed: true,
        requiresApproval: needApproval('medium'),
        risk: 'medium',
        reason: '写入工作目录之外的文件',
      };
    },
  };
}
