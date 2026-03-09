import 'dotenv/config';

async function testAuth() {
  console.log('=== OKX Authentication Diagnostic ===\n');

  // 1. Check env vars
  const apiKey = process.env.OKX_API_KEY ?? '';
  const secret = process.env.OKX_SECRET ?? '';
  const passphrase = process.env.OKX_PASSPHRASE ?? '';

  console.log('API Key:', apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '(empty)');
  console.log('Secret:', secret ? `${secret.substring(0, 8)}...${secret.substring(secret.length - 4)}` : '(empty)');
  console.log('Passphrase:', passphrase ? `"${passphrase}" (length: ${passphrase.length})` : '(empty)');
  console.log('Sandbox:', process.env.OKX_SANDBOX);
  console.log('');

  // Check for whitespace issues
  if (apiKey !== apiKey.trim()) console.log('⚠️  API Key has leading/trailing whitespace!');
  if (secret !== secret.trim()) console.log('⚠️  Secret has leading/trailing whitespace!');
  if (passphrase !== passphrase.trim()) console.log('⚠️  Passphrase has leading/trailing whitespace!');

  const ccxt = await import('ccxt');

  // 2. Test public API (no auth needed)
  console.log('--- Test 1: Public API (no auth) ---');
  try {
    const publicExchange = new ccxt.okx({
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    const markets = await publicExchange.loadMarkets();
    const swapCount = Object.values(markets).filter((m: any) => m.type === 'swap').length;
    console.log(`✅ Public loadMarkets() OK — ${swapCount} swap markets found\n`);
  } catch (err: any) {
    console.log(`❌ Public loadMarkets() failed: ${err.message}\n`);
  }

  // 3. Test authenticated API
  console.log('--- Test 2: Authenticated API ---');
  try {
    const authExchange = new ccxt.okx({
      apiKey: apiKey.trim(),
      secret: secret.trim(),
      password: passphrase.trim(),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });

    // loadMarkets should work without auth
    await authExchange.loadMarkets();
    console.log('✅ loadMarkets() OK');

    // fetchBalance requires auth
    const balance = await authExchange.fetchBalance({ type: 'swap' });
    console.log('✅ fetchBalance() OK');
    console.log('   USDT balance:', balance?.USDT?.free ?? 'N/A');

  } catch (err: any) {
    console.log(`❌ Error: ${err.constructor.name}`);
    console.log(`   Message: ${err.message}`);
    if (err.code) console.log(`   Code: ${err.code}`);
    if (err.statusCode) console.log(`   HTTP Status: ${err.statusCode}`);

    // Try to extract OKX error code from message
    const match = err.message?.match(/"code":"(\d+)"/);
    if (match) {
      const okxCode = match[1];
      console.log(`   OKX Error Code: ${okxCode}`);
      if (okxCode === '50111') console.log('   → Invalid API Key');
      if (okxCode === '50113') console.log('   → Invalid Sign (wrong secret or passphrase)');
      if (okxCode === '50114') console.log('   → Invalid Nonce');
      if (okxCode === '50115') console.log('   → Invalid Passphrase');
    }
  }

  // 4. Test with sub-account header
  console.log('\n--- Test 3: With x-simulated-trading header (sandbox) ---');
  try {
    const sandboxExchange = new ccxt.okx({
      apiKey: apiKey.trim(),
      secret: secret.trim(),
      password: passphrase.trim(),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    sandboxExchange.setSandboxMode(true);
    await sandboxExchange.loadMarkets();
    const balance = await sandboxExchange.fetchBalance({ type: 'swap' });
    console.log('✅ Sandbox mode works');
    console.log('   USDT balance:', balance?.USDT?.free ?? 'N/A');
  } catch (err: any) {
    console.log(`❌ Sandbox Error: ${err.constructor.name} — ${err.message?.substring(0, 200)}`);
  }

  console.log('\n=== Diagnostic Complete ===');
}

testAuth().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
