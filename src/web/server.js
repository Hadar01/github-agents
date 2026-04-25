const express = require('express');
const path = require('path');

function createDashboard() {
  const app = express();
  const subscribers = new Set();
  const buffer = []; // replay events to late-joining clients
  const BUFFER_LIMIT = 1000;

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Replay buffered events so reloads show full history
    for (const e of buffer) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }

    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
  });

  function pushEvent(event) {
    const stamped = { ...event, ts: Date.now() };
    buffer.push(stamped);
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
    const payload = `data: ${JSON.stringify(stamped)}\n\n`;
    for (const sub of subscribers) {
      // If a write fails (socket destroyed, client gone), drop the dead
      // subscriber rather than letting the Set grow unbounded.
      try { sub.write(payload); } catch { subscribers.delete(sub); }
    }
  }

  // Default to localhost-only — agent output (thoughts, file paths, command
  // stdout, occasionally stack traces) is sensitive. Pass host: '0.0.0.0' (or
  // any external interface) only via the explicit `--web-bind-all` flag.
  function start(port = 3000, { host = '127.0.0.1' } = {}) {
    return new Promise(resolve => {
      const server = app.listen(port, host, () => resolve(server));
    });
  }

  return { start, pushEvent };
}

module.exports = { createDashboard };
