/**
 * 界面截图 + 运行时错误巡检（用 Electron 直接渲染 dist/renderer，走 mock 桥接）
 * 用法：npx electron scripts/screenshot.cjs
 * 产出：docs/images/*.png，并打印页面 console 错误
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 每次都用全新的用户数据目录：localStorage 干净，首次引导页才会出现，会话列表也不会残留上次的测试数据
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-shot-'));
app.setPath('userData', profileDir);
const indexFile = path.join(root, 'dist', 'renderer', 'index.html');
const outDir = path.join(root, 'docs', 'images');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  const { width, height } = img.getSize();
  console.log(`[shot] ${name}.png ${width}x${height}`);
}

async function clickByText(win, regex) {
  return win.webContents.executeJavaScript(`(() => {
    const re = new RegExp(${JSON.stringify(regex)}, 'i');
    const nodes = [...document.querySelectorAll('button, a, [role="button"], div[class*="card"], div[class*="Card"]')];
    const hit = nodes.find((n) => re.test((n.textContent || '').trim()) && n.offsetParent !== null);
    if (!hit) return null;
    hit.click();
    return (hit.textContent || '').trim().slice(0, 40);
  })()`);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(indexFile)) {
    console.error('缺少 dist/renderer/index.html，请先 npm run build:renderer');
    app.exit(1);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 必须真实显示：隐藏窗口切换主题后 capturePage 可能拿到旧帧
    show: true,
    backgroundColor: '#0b0f17',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone: ${JSON.stringify(d)}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));

  await win.loadFile(indexFile);
  await wait(2200);
  await shot(win, '01-welcome');

  // 引导页：尝试点「先跳过 / 直接进入」
  const entered = await clickByText(win, '跳过|先跳过|直接进入|进入演示|完成|开始使用');
  console.log('[nav] 引导按钮:', entered);
  await wait(1200);
  await shot(win, '02-home');

  // 输入一句话，触发 mock 流式回复
  const typed = await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '帮我整理一下下载文件夹，把图片按日期归档');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return true;
  })()`);
  console.log('[nav] 输入框:', typed);
  if (typed) {
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('textarea');
      const form = ta && ta.closest('form');
      if (form) { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return 'form'; }
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return 'keydown';
    })()`);
    await wait(2600);
    await shot(win, '03-thinking');
    await wait(4000);
    await shot(win, '04-reply');
  }

  // 设置界面
  const opened = await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('button[title="设置"]');
    if (btn) { btn.click(); return 'button[title=设置]'; }
    const ev = new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return 'ctrl+, fallback';
  })()`);
  await wait(600);
  const openedCheck = await win.webContents.executeJavaScript(`(() => {
    const dlg = document.querySelector('[class*="settings"], [role="dialog"]');
    return dlg ? (dlg.className || 'dialog') : 'MISSING';
  })()`);
  console.log('[nav] 设置容器:', openedCheck);
  console.log('[nav] 设置入口:', opened);
  await wait(1400);
  await shot(win, '05-settings');

  // 设置里切到「外观」分组并截图（用精确选择器，避免点到侧栏同名文字）
  const switched = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.settings-nav-btn')].find((n) => (n.textContent || '').includes('外观'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  console.log('[nav] 外观分组:', switched);
  await wait(900);
  await shot(win, '06-appearance');

  // 浅色主题下再截一张，验证对比度
  // React 19 对程序化 .click() 的合成事件不总生效，这里用真实鼠标事件点主题 chip
  const chipRect = await win.webContents.executeJavaScript(`(() => {
    const chip = [...document.querySelectorAll('.theme-chip')].find((n) => (n.textContent || '').includes('浅色'));
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (chipRect) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: chipRect.x, y: chipRect.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: chipRect.x, y: chipRect.y, button: 'left', clickCount: 1 });
    await wait(1000);
    const themeNow = await win.webContents.executeJavaScript(`document.documentElement.getAttribute('data-theme')`);
    console.log('[nav] 主题切换后:', themeNow);
    await shot(win, '07-light-theme');
  }

  console.log(`[console] 页面错误数: ${errors.length}`);
  for (const e of errors.slice(0, 12)) console.log('  !', e);

  app.exit(errors.length > 0 ? 2 : 0);
});
