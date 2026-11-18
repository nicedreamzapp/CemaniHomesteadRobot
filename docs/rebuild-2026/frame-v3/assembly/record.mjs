// Record viewer-4ws-ucf204.html?real?record frame by frame into an MP4 (24 fps, 1280x720).
// node record.mjs <out.mp4>
import { chromium } from '/Users/dtribe/Desktop/PROJECTS/marketplace-realism/npm/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const out = process.argv[2] || 'steering_builds_itself.mp4';
const page_url = 'file://' + path.resolve('viewer-4ws-ucf204.html?real') + '?record';
const FPS = 24;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.error('PAGE ERROR', e.message));
await page.goto(page_url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
const total = await page.evaluate(() => window.__total);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const n = Math.ceil(total * FPS);
for (let i = 0; i < n; i++) {
  await page.evaluate(t => window.__frame(t), i / FPS);
  ff.stdin.write(await page.screenshot({ type: 'jpeg', quality: 92 }));
  if (i % 240 === 0) console.log(`frame ${i}/${n}`);
}
ff.stdin.end(); await new Promise(r => ff.on('close', r)); await browser.close();
console.log('done', out, n, 'frames');
