import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginPage from "@/app/login/page";

describe("LoginPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits credentials and redirects on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<LoginPage />);
    const usernameInput = container.querySelector('input[autocomplete="username"]');
    const passwordInput = container.querySelector('input[type="password"]');
    expect(usernameInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    fireEvent.change(usernameInput!, { target: { value: "admin" } });
    fireEvent.change(passwordInput!, { target: { value: "user" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "user" }),
      });
    });
  });

  it("shows API error when login fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false, error: "invalid credentials" }),
      })
    );

    const { container } = render(<LoginPage />);
    const usernameInput = container.querySelector('input[autocomplete="username"]');
    const passwordInput = container.querySelector('input[type="password"]');
    expect(usernameInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    fireEvent.change(usernameInput!, { target: { value: "admin" } });
    fireEvent.change(passwordInput!, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(await screen.findByText("invalid credentials")).toBeInTheDocument();
  });
});
