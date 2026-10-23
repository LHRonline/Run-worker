/**
 * 由多尺寸 PNG 组装 Windows .ico（PNG 压缩格式，Vista+ 支持）
 * 用法：node scripts/make-ico.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const sizes = [16, 32, 48, 64, 128, 256];

const images = sizes
  .map((size) => {
    const file = path.join(assets, `icon-${size}.png`);
    if (!fs.existsSync(file)) return null;
    return { size, data: fs.readFileSync(file) };
  })
  .filter(Boolean);

if (images.length === 0) {
  console.error('未找到图标源文件，请先运行 postprocess-assets.cjs');
  process.exit(1);
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;

for (const img of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
  entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(img.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += img.data.length;
  entries.push(entry);
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
const out = path.join(root, 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
console.log(`icon.ico 已生成：${(ico.length / 1024).toFixed(1)} KB，包含 ${images.length} 个尺寸`);
