import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runBotCron, isKvConfigured } from '../dist/vercel/botRunner';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isKvConfigured()) {
    return res.status(503).json({
      error: 'Redis required. In Vercel: Marketplace → search Redis → add Upstash → connect to this project.',
    });
  }

  try {
    const snapshot = await runBotCron();
    res.status(200).json({ ok: true, updatedAt: snapshot.updatedAt });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
