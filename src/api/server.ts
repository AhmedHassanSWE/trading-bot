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

function sendHtml(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: 'Dashboard not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

export function startApiServer(bot: TradingBot, port = config.api.port): http.Server {
  const dashboardPath = path.join(process.cwd(), 'public', 'index.html');

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
        sendHtml(res, dashboardPath);
        return;
      }

      if (url === '/api/status') {
        const snapshot = await bot.getDashboardSnapshot();
        sendJson(res, 200, snapshot);
        return;
      }

      if (url === '/api/wallet') {
        const snapshot = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          wallet: snapshot.wallet,
          startingBalance: snapshot.startingBalance,
          totalPnl: snapshot.totalPnl,
          totalPnlPct: snapshot.totalPnlPct,
          updatedAt: snapshot.updatedAt,
        });
        return;
      }

      if (url === '/api/position') {
        const snapshot = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          openPosition: snapshot.openPosition,
          currentPrice: snapshot.currentPrice,
          updatedAt: snapshot.updatedAt,
        });
        return;
      }

      if (url === '/api/trades') {
        const snapshot = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          trades: snapshot.recentTrades,
          stats: snapshot.stats,
          updatedAt: snapshot.updatedAt,
        });
        return;
      }

      if (url === '/api/events') {
        const snapshot = await bot.getDashboardSnapshot();
        sendJson(res, 200, {
          events: snapshot.recentEvents,
          updatedAt: snapshot.updatedAt,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error('API error', { error: String(err) });
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, () => {
    logger.info(`Dashboard API running at http://localhost:${port}`);
  });

  return server;
}
