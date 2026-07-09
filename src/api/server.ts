import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TradingBot } from '../bot/engine';

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function sendHtml(res: http.ServerResponse, filePath: string): void {
  sendFile(res, filePath, 'text/html; charset=utf-8');
}

export function startApiServer(bot: TradingBot, port = config.api.port): http.Server {
  const publicDir = path.join(process.cwd(), 'public');

  const server = http.createServer(async (req, res) => {
    const url = req.url?.split('?')[0] ?? '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      if (url === '/' || url === '/index.html') {
        sendHtml(res, path.join(publicDir, 'index.html'));
        return;
      }

      if (url === '/config.js') {
        sendFile(res, path.join(publicDir, 'config.js'), 'application/javascript; charset=utf-8');
        return;
      }

      if (url === '/api/status') {
        sendJson(res, 200, await bot.getDashboardSnapshot());
        return;
      }

      if (url === '/api/wallet') {
        const s = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          startingBalance: s.startingBalance,
          currentBalance: s.currentBalance,
          totalPnl: s.totalPnl,
          totalPnlPct: s.totalPnlPct,
          updatedAt: s.updatedAt,
        });
        return;
      }

      if (url === '/api/position') {
        const s = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          openPosition: s.openPosition,
          currentPrice: s.currentPrice,
          updatedAt: s.updatedAt,
        });
        return;
      }

      if (url === '/api/trades') {
        const s = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          trades: s.recentTrades,
          stats: s.stats,
          updatedAt: s.updatedAt,
        });
        return;
      }

      if (url === '/api/events') {
        const s = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          events: s.recentEvents,
          updatedAt: s.updatedAt,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error('API error', { error: String(err) });
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is already in use. Stop the other bot (lsof -ti :${port} | xargs kill) or change config.api.port`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });

  return server;
}
