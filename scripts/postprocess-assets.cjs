/**
 * 用 Electron 的 nativeImage 做图片后处理：
 * 1) 裁掉 assets/cover.png 右下角的生成水印
 * 2) 生成安装器/窗口图标所需的 512/256 PNG
 * 用法：npx electron scripts/postprocess-assets.cjs
 */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');

function save(img, file) {
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  console.log(`saved ${path.relative(root, file)} ${size.width}x${size.height}`);
}

app.whenReady().then(() => {
  try {
    const coverPath = path.join(assets, 'cover.png');
    const cover = nativeImage.createFromPath(coverPath);
    const { width, height } = cover.getSize();
    console.log('cover original', width, height);

    // 去掉底部 46px（右下角水印区域）并整体重编码
    const trimmed = cover.crop({ x: 0, y: 0, width, height: Math.max(1, height - 46) });
    save(trimmed, coverPath);
    save(trimmed, path.join(root, 'src/renderer/public/cover.png'));

    const iconPath = path.join(assets, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    console.log('icon original', icon.getSize());
    const square = icon.getSize().width >= icon.getSize().height
      ? icon.crop({ x: 0, y: 0, width: icon.getSize().height, height: icon.getSize().height })
      : icon.crop({ x: 0, y: 0, width: icon.getSize().width, height: icon.getSize().width });

    for (const size of [512, 256, 128, 64, 48, 32, 16]) {
      save(square.resize({ width: size, height: size, quality: 'best' }), path.join(assets, `icon-${size}.png`));
    }
    save(square.resize({ width: 512, height: 512, quality: 'best' }), iconPath);
    save(square.resize({ width: 512, height: 512, quality: 'best' }), path.join(root, 'src/renderer/public/icon.png'));

    const buildDir = path.join(root, 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    save(square.resize({ width: 512, height: 512, quality: 'best' }), path.join(buildDir, 'icon.png'));
    console.log('done');
  } catch (err) {
    console.error('postprocess failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
