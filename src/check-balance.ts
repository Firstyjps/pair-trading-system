import 'dotenv/config';

async function check() {
  const ccxt = await import('ccxt');
  const exchange = new ccxt.okx({
    apiKey: process.env.OKX_API_KEY!.trim(),
    secret: process.env.OKX_SECRET!.trim(),
    password: process.env.OKX_PASSPHRASE!.trim(),
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });

  // Check trading account balance
  const balance = await exchange.fetchBalance({ type: 'swap' });
  console.log('=== Trading Account Balance ===');
  
  const usdt = balance?.USDT || balance?.info?.data?.[0];
  if (balance?.USDT) {
    console.log(`USDT Free:  ${balance.USDT.free}`);
    console.log(`USDT Used:  ${balance.USDT.used}`);
    console.log(`USDT Total: ${balance.USDT.total}`);
  } else {
    // Try fetching from funding account
    console.log('Swap balance:', JSON.stringify(balance?.total, null, 2));
  }

  // Also check funding balance
  try {
    const funding = await exchange.fetchBalance({ type: 'funding' });
    if (funding?.USDT) {
      console.log(`\n=== Funding Account ===`);
      console.log(`USDT Free:  ${funding.USDT.free}`);
      console.log(`USDT Total: ${funding.USDT.total}`);
    }
  } catch (e: any) {
    console.log('\nFunding check:', e.message?.substring(0, 100));
  }

  // Check config
  const maxCapital = Number(process.env.MAX_CAPITAL_PER_PAIR || 300);
  const maxPairs = Number(process.env.MAX_OPEN_PAIRS || 8);
  const leverage = Number(process.env.DEFAULT_LEVERAGE || 5);
  
  const totalUSDT = Number(balance?.USDT?.total || 0);
  const maxNeeded = maxCapital * 2 * maxPairs; // 2 legs per pair
  
  console.log(`\n=== Trading Capacity ===`);
  console.log(`Capital per pair: $${maxCapital} × 2 legs = $${maxCapital * 2}`);
  console.log(`Max pairs: ${maxPairs}`);
  console.log(`Leverage: ${leverage}x`);
  console.log(`Max margin needed: $${maxNeeded / leverage} (with ${leverage}x leverage)`);
  console.log(`Available: $${totalUSDT}`);
  
  if (totalUSDT > 0) {
    const possiblePairs = Math.floor(totalUSDT / (maxCapital * 2 / leverage));
    console.log(`\n✅ Can open up to ${possiblePairs} pairs`);
  } else {
    console.log(`\n⚠️  เงินอาจอยู่ใน Funding account — ต้องโอนไป Trading account`);
  }
}

check().catch(e => console.error('Error:', e.message));
