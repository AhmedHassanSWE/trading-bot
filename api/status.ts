import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDashboardSnapshot, isKvConfigured } from '../dist/vercel/botRunner';

function cors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = await getDashboardSnapshot();
    res.status(200).json({
      ...data,
      kvConfigured: isKvConfigured(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
