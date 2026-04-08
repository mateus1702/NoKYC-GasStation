import waitPort from 'wait-port';

const rpc = process.env.ANVIL_RPC?.trim();
if (!rpc) throw new Error("ANVIL_RPC required (set in .env)");
const url = new URL(rpc);

(async () => {
  const ok = await waitPort({
    host: url.hostname,
    port: parseInt(url.port || '80'),
    timeout: 10000, // 10s timeout
    output: 'silent',
  });

  if (!ok) {
    console.error(`❌ Timed out waiting for ${url.hostname}:${url.port}`);
    process.exit(1);
  }

  console.log(`✅ ${url.hostname}:${url.port} is available`);
})();
