/**
 * Server-side container logs via docker compose logs.
 * Sanitizes inputs, uses allowlist, timeout. Fails soft when unavailable.
 */
import { spawn } from "node:child_process";

const ALLOWED_SERVICES = new Set([
  "anvil",
  "contract-deployer",
  "bundler-alto",
  "paymaster-api",
  "valkey",
  "worker",
  "dashboard",
]);
const ALLOWED_TAIL = new Set([100, 250, 500]);
const DEFAULT_TAIL = 100;
const TIMEOUT_MS = 5000;

const COMPOSE_FILE = process.env.DASHBOARD_COMPOSE_FILE || "";
const COMPOSE_CWD = process.env.DASHBOARD_COMPOSE_CWD || process.cwd();

export interface LogsPayload {
  status: "ok" | "error";
  service: string;
  tail: number;
  timestamp: string;
  lines: string[];
  error?: string;
}

function sanitizeService(service: string | null): string {
  if (!service || service === "all") return "all";
  const s = String(service).toLowerCase().trim();
  return ALLOWED_SERVICES.has(s) ? s : "worker";
}

function sanitizeTail(tail: string | null): number {
  if (!tail) return DEFAULT_TAIL;
  const n = parseInt(String(tail), 10);
  return ALLOWED_TAIL.has(n) ? n : DEFAULT_TAIL;
}

export async function fetchLogs(service: string | null, tail: string | null): Promise<LogsPayload> {
  const svc = sanitizeService(service);
  const tailNum = sanitizeTail(tail);

  const args = [
    "compose",
    "-f",
    COMPOSE_FILE,
    "logs",
    "--no-color",
    `--tail=${tailNum}`,
  ];
  if (svc !== "all") {
    args.push(svc);
  }

  const payload: LogsPayload = {
    status: "error",
    service: svc,
    tail: tailNum,
    timestamp: new Date().toISOString(),
    lines: [],
    error: "Logs unavailable in this runtime",
  };

  return new Promise((resolve) => {
    const proc = spawn("docker", args, {
      cwd: COMPOSE_CWD,
      shell: process.platform === "win32",
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      payload.error = "Log fetch timed out";
      resolve(payload);
    }, TIMEOUT_MS);

    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => chunks.push(d));

    proc.on("error", (err) => {
      clearTimeout(timeout);
      payload.error = err.message || "Failed to run docker compose logs";
      resolve(payload);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const out = Buffer.concat(chunks).toString("utf8");
      const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
      payload.lines = lines;
      if (code === 0 || lines.length > 0) {
        payload.status = "ok";
        payload.error = undefined;
      } else if (payload.error === "Logs unavailable in this runtime") {
        payload.error = code != null ? `Command exited with code ${code}` : "Command failed";
      }
      resolve(payload);
    });
  });
}
