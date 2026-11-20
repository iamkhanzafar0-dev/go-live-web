const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

let cloudFfmpeg = null;
let cloudStartedAt = null;
let manualStop = false;
let currentConfig = null;

function launchPersistentUrlStream(config) {
  if (cloudFfmpeg) {
    cloudFfmpeg.kill('SIGKILL');
    cloudFfmpeg = null;
  }

  const { videoUrl, rtmpTargets, loop } = config;
  const teeTargets = rtmpTargets.map(u => `[f=flv:onfail=ignore]${u}`).join('|');

  const args = [
    '-re',
    ...(loop ? ['-stream_loop', '-1'] : []),
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', videoUrl,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'tee', '-map', '0:v', '-map', '0:a?', teeTargets
  ];

  cloudFfmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });
  if (!cloudStartedAt) cloudStartedAt = Date.now();

  cloudFfmpeg.on('exit', () => {
    cloudFfmpeg = null;
    if (!manualStop && loop && currentConfig) {
      setTimeout(() => launchPersistentUrlStream(currentConfig), 3000);
    } else {
      cloudStartedAt = null;
    }
  });
}

app.post('/api/start-url-stream', (req, res) => {
  const { videoUrl, rtmpTargets, loop = true } = req.body;
  if (!videoUrl || !rtmpTargets || !rtmpTargets.length) {
    return res.status(400).json({ ok: false, error: 'Missing videoUrl or rtmpTargets' });
  }
  manualStop = false;
  currentConfig = { videoUrl, rtmpTargets, loop };
  launchPersistentUrlStream(currentConfig);
  res.json({ ok: true, message: '24/7 Cloud Stream started' });
});

app.post('/api/stop-url-stream', (req, res) => {
  manualStop = true;
  currentConfig = null;
  if (cloudFfmpeg) {
    cloudFfmpeg.kill('SIGKILL');
    cloudFfmpeg = null;
  }
  cloudStartedAt = null;
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  const running = Boolean(cloudFfmpeg);
  const mins = cloudStartedAt ? Math.floor((Date.now() - cloudStartedAt) / 60000) : 0;
  res.json({ running, uptime: running ? `${mins} min` : '0 min' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const targets = url.searchParams.getAll('rtmp');
  if (!targets.length) return ws.close();

  const teeTargets = targets.map(u => `[f=flv:onfail=ignore]${u}`).join('|');
  const ff = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'tee', '-map', '0:v', '-map', '0:a?', teeTargets
  ]);

  ws.on('message', chunk => { if (ff.stdin.writable) ff.stdin.write(chunk); });
  ws.on('close', () => { ff.stdin.end(); ff.kill('SIGINT'); });
});

server.listen(process.env.PORT || 8080, () => console.log('GO LIVE 24/7 Cloud Relay running'));
