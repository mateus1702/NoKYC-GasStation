import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DashboardPage from "@/app/page";

const { replaceMock, useSWRMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  useSWRMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("swr", () => ({
  default: useSWRMock,
  useSWRConfig: () => ({ mutate: vi.fn(), cache: new Map() }),
}));

vi.mock("framer-motion", () => {
  const motion = new Proxy(
    {},
    {
      get: (_target, tag) =>
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          React.createElement(tag as string, props, children),
    }
  );
  return {
    motion,
    AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  };
});

const dormantSwr = () => ({
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: vi.fn(),
});

describe("DashboardPage smoke", () => {
  beforeEach(() => {
    useSWRMock.mockReset();
    replaceMock.mockReset();
  });

  it("renders loading state while metrics are loading", () => {
    useSWRMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      isValidating: false,
      mutate: vi.fn(),
    });

    render(<DashboardPage />);
    expect(screen.getByText("Loading Dashboard")).toBeInTheDocument();
  });

  it("renders dashboard shell when metrics load successfully", () => {
    useSWRMock.mockImplementation((key: string | null) => {
      if (key === "/api/metrics") {
        return {
          data: {
            timestamp: new Date().toISOString(),
            paymasterAddress: { status: "ok", value: "0x1234567890abcdef1234567890abcdef12345678" },
            health: { paymasterApi: "ok", bundler: "ok" },
          },
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: vi.fn(),
        };
      }
      if (key === null) {
        return dormantSwr();
      }
      return {
        data: { status: "ok" as const, items: [] },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    });

    render(<DashboardPage />);
    expect(screen.getByText("NoKYC-GasStation")).toBeInTheDocument();
    expect(screen.getByText(/Overview auto-refresh every 5 minutes/i)).toBeInTheDocument();
  });

  it("shows Control plane tab panel when Control plane tab is selected", async () => {
    useSWRMock.mockImplementation((key: string | null) => {
      if (key === "/api/metrics") {
        return {
          data: {
            timestamp: new Date().toISOString(),
            paymasterAddress: { status: "ok", value: "0x1234567890abcdef1234567890abcdef12345678" },
            health: { paymasterApi: "ok", bundler: "ok" },
          },
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: vi.fn(),
        };
      }
      if (key === null) {
        return dormantSwr();
      }
      return {
        data: { status: "ok" as const, items: [] },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    });

    render(<DashboardPage />);
    fireEvent.click(screen.getByRole("button", { name: "Control plane" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run operational refill" })).toBeInTheDocument();
    });
  });

  it("redirects to login on unauthorized metrics response", async () => {
    const unauthorized = Object.assign(new Error("unauthorized"), { status: 401 });
    useSWRMock.mockImplementation((key: string | null) => {
      if (key === "/api/metrics") {
        return {
          data: undefined,
          error: unauthorized,
          isLoading: false,
          isValidating: false,
          mutate: vi.fn(),
        };
      }
      if (key === null) {
        return dormantSwr();
      }
      return {
        data: { status: "ok" as const, items: [] },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    });

    render(<DashboardPage />);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login");
    });
  });
});
