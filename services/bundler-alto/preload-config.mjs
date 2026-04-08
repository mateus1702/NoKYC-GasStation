/**
 * Merge non-secret bundler config from Valkey hash `config:bundler` into process.env.
 * Uses raw RESP over TCP (node:net), so no npm install is needed in the base Alto image.
 */
import net from "node:net";

function parseRedisUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (u.protocol !== "redis:") throw new Error(`Unsupported VALKEY_URL protocol: ${u.protocol}`);
  return {
    host: u.hostname || "127.0.0.1",
    port: Number(u.port || "6379"),
  };
}

function encodeRespArray(parts) {
  let out = `*${parts.length}\r\n`;
  for (const p of parts) {
    out += `$${Buffer.byteLength(p, "utf8")}\r\n${p}\r\n`;
  }
  return out;
}

function parseRespValue(buf) {
  let i = 0;
  function readLine() {
    const end = buf.indexOf("\r\n", i);
    if (end < 0) throw new Error("Malformed RESP line");
    const line = buf.slice(i, end);
    i = end + 2;
    return line;
  }
  function readOne() {
    const tag = buf[i++];
    if (tag === "+") return readLine();
    if (tag === "-") throw new Error(readLine());
    if (tag === ":") return Number(readLine());
    if (tag === "$") {
      const len = Number(readLine());
      if (len < 0) return null;
      const s = buf.slice(i, i + len);
      i += len + 2;
      return s;
    }
    if (tag === "*") {
      const n = Number(readLine());
      if (n < 0) return null;
      const arr = [];
      for (let j = 0; j < n; j++) arr.push(readOne());
      return arr;
    }
    throw new Error(`Unsupported RESP tag: ${tag}`);
  }
  return readOne();
}

async function hgetall(host, port, key) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = "";
    socket.setTimeout(5000);
    socket.on("connect", () => socket.write(encodeRespArray(["HGETALL", key])));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      try {
        const parsed = parseRespValue(data);
        if (!Array.isArray(parsed)) {
          socket.destroy();
          return reject(new Error("HGETALL returned non-array response"));
        }
        const out = {};
        for (let k = 0; k < parsed.length; k += 2) {
          const kk = parsed[k];
          const vv = parsed[k + 1];
          if (typeof kk === "string" && typeof vv === "string") out[kk] = vv;
        }
        socket.end();
        resolve(out);
      } catch {
        // Wait for more chunks.
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Redis socket timeout"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      // no-op
    });
  });
}

export async function loadBundlerConfigFromRedis() {
  const url = process.env.VALKEY_URL?.trim();
  const prefix = process.env.VALKEY_KEY_PREFIX?.trim();
  if (!url || !prefix) return;
  const { host, port } = parseRedisUrl(url);
  const raw = await hgetall(host, port, `${prefix}config:bundler`);

  const copy = (k) => {
    const v = raw[k];
    if (v !== undefined && v !== "") process.env[k] = v;
  };
  copy("ALTO_RPC_URL");
  copy("PAYMASTER_CONTRACT_ENTRYPOINT_ADDRESS");
  copy("ALTO_NETWORK_NAME");
  copy("ALTO_LOG_ENV");
  copy("ALTO_LOG_LEVEL");
  copy("ALTO_MIN_BALANCE");
  copy("ALTO_BLOCK_RANGE_LIMIT");
  if (raw.ALTO_BLOCK_RANGE_LIMIT) {
    process.env.ALTO_MAX_BLOCK_RANGE = raw.ALTO_BLOCK_RANGE_LIMIT;
  }
}
