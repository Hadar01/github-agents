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
      try { sub.write(payload); } catch {}
    }
  }

  function start(port = 3000) {
    return new Promise(resolve => {
      const server = app.listen(port, () => resolve(server));
    });
  }

  return { start, pushEvent };
}

module.exports = { createDashboard };
