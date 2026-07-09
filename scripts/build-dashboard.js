/**
 * Optional: inject BOT_API_URL into public/config.js before deploy.
 * Usage: BOT_API_URL=https://your-bot.up.railway.app node scripts/build-dashboard.js
 *
 * Do NOT set this as Vercel buildCommand — it makes Vercel treat the repo as a
 * Node app and crash. Edit public/config.js directly, or run this script locally
 * before pushing.
 */
const fs = require('fs');
const path = require('path');

const apiUrl = process.env.BOT_API_URL || '';
const configPath = path.join(__dirname, '../public/config.js');
const safeUrl = apiUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const content = `// Auto-generated — set BOT_API_URL env var when running build-dashboard.js
window.BOT_API_URL = '${safeUrl}';
`;

fs.writeFileSync(configPath, content);
console.log(`Wrote ${configPath} → ${apiUrl || '(empty, uses same origin)'}`);
