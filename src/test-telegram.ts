/**
 * Test Telegram notifications — ส่งข้อความทดสอบไปยัง Telegram
 * Usage: npx tsx src/test-telegram.ts
 */
import 'dotenv/config';
import { Bot } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error('❌ ต้องตั้งค่า TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID ใน .env');
  process.exit(1);
}

const bot = new Bot(token);

// ข้อความทดสอบแบบ PnL Report (เหมือน Pairtrading bot)
function buildTestMessage(): string {
  const d = new Date();
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear() + 543;
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const timestamp = `${day}/${month}/${year} ${h}:${m}:${s}`;

  return [
    '📊 *กำไร/ขาดทุน*',
    '',
    '─── คู่เทรด (Pair) ───',
    '🟢 HMSTR/BABY: +0.00%',
    '🟢 SATS/RSR: +0.00%',
    '🔴 GALA/NOT: -0.27%',
    '🔴 RESOLV/RSR: -0.45%',
    '',
    '─── ออเดอร์บน OKX ───',
    '🟢 BABY (long): +$5.96',
    '🔴 HMSTR (short): $-4.89',
    '🔴 RSR (short): $-21.84',
    '🟢 RESOLV (long): +$119.41',
    '🟢 NOT (long): +$9.27',
    '🔴 GALA (short): $-5.11',
    '',
    '─── สรุป ───',
    'กำไร/ขาดทุนรวม: +$102.81',
    'ยอดเงินทั้งหมด: $9902.36',
    '',
    `⏰ ${timestamp}`,
    '',
    '_🧪 นี่คือข้อความทดสอบจาก test-telegram.ts_',
  ].join('\n');
}

async function main() {
  console.log('📤 ส่งข้อความทดสอบไปยัง Telegram...');

  try {
    await bot.api.sendMessage(chatId!, buildTestMessage(), {
      parse_mode: 'Markdown',
    });
    console.log('✅ ส่งสำเร็จ! ตรวจสอบ Telegram ได้เลย');
  } catch (err: any) {
    console.error('❌ ส่งไม่สำเร็จ:', err.message);
    process.exit(1);
  }
}

main();
