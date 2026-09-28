import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fail, sleep } from './shared.mjs';

const FPS = 10;
const FRAME_MS = 1000 / FPS;

// CDP provides changed frames; repeat the most recent frame at a steady rate so
// quiet periods in the browser have the correct duration in the resulting MP4.
export async function startVideo(browser) {
  if (browser.video) fail('VIDEO_ACTIVE', 'Stop the current recording first.');
  const { page, context, runDir } = browser;
  const viewport = page.viewportSize();
  const output = join(runDir, `video-${randomUUID()}.mp4`);
  let frame = await page.screenshot({ type: 'jpeg', quality: 75 });
  const cdp = await context.newCDPSession(page);
  let encoderError, diagnostics = '';
  const encoder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-n',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  encoder.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  encoder.stdin.on('error', (error) => { encoderError = error; });
  encoder.on('error', (error) => { encoderError = error; });
  const finished = new Promise((resolve) => encoder.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      encoder.once('spawn', resolve);
      encoder.once('error', reject);
    });
  } catch (error) {
    await cdp.detach().catch(() => {});
    fail('FFMPEG_UNAVAILABLE', `Video recording needs FFmpeg (${error.message}). Install it or set FFMPEG_PATH.`);
  }

  let active = true, frames = 0, pumpError;
  const started = performance.now();
  const onFrame = ({ data, sessionId }) => {
    frame = Buffer.from(data, 'base64');
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  };
  async function writeFrame() {
    if (encoderError) throw encoderError;
    await new Promise((resolve, reject) => encoder.stdin.write(frame, (error) => error ? reject(error) : resolve()));
    frames++;
  }
  async function pump() {
    while (active) {
      const elapsed = performance.now() - started;
      if (frames < Math.floor(elapsed / FRAME_MS) + 1) await writeFrame();
      else await sleep(Math.max(5, Math.min(50, frames * FRAME_MS - elapsed)));
    }
  }
  try {
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 75, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1,
    });
  } catch (error) {
    active = false;
    encoder.stdin.destroy();
    encoder.kill();
    await finished;
    await cdp.detach().catch(() => {});
    throw error;
  }
  const pumping = pump().catch((error) => { pumpError = error; active = false; });
  let stopWork;
  const recording = {
    stop() {
      stopWork ??= (async () => {
        active = false;
        await pumping;
        try {
          if (pumpError) throw pumpError;
          // Cover the time since the final tick, including an idle tail.
          const needed = Math.max(1, Math.ceil((performance.now() - started) / FRAME_MS));
          while (frames < needed) await writeFrame();
          encoder.stdin.end();
          const { code, signal } = await finished;
          if (encoderError || code !== 0) fail('VIDEO_FAILED', `FFmpeg could not finish the MP4 (${encoderError?.message || diagnostics || signal || code}).`);
          const file = await stat(output);
          if (!file.size) fail('VIDEO_FAILED', 'FFmpeg created an empty MP4.');
          return { path: output, format: 'mp4', codec: 'h264', width: viewport.width - viewport.width % 2,
            height: viewport.height - viewport.height % 2, fps: FPS, durationSeconds: frames / FPS, bytes: file.size };
        } catch (error) {
          await rm(output, { force: true }).catch(() => {});
          throw error;
        } finally {
          cdp.off('Page.screencastFrame', onFrame);
          await cdp.send('Page.stopScreencast').catch(() => {});
          await cdp.detach().catch(() => {});
          if (encoder.exitCode === null) { encoder.stdin.destroy(); encoder.kill(); await finished; }
          browser.video = undefined;
        }
      })();
      return stopWork;
    },
  };
  browser.video = recording;
  return { recording: true, viewport };
}
