import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

if (!process.env.VALKEY_URL) {
  process.env.VALKEY_URL = "redis://127.0.0.1:6379";
}
if (!process.env.VALKEY_KEY_PREFIX) {
  process.env.VALKEY_KEY_PREFIX = "vitest:";
}

afterEach(() => {
  cleanup();
});
