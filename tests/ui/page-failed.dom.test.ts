// @vitest-environment jsdom
/**
 * UIL-106 (4) — the app-level error boundary, for whatever the named fixes did not catch.
 *
 * Before it, a throw no screen caught (Sign out's form action when the call never arrived, a render that
 * failed) fell to Next's default error page, which told her nothing she could act on. Rendered here as Next
 * renders it: the boundary's default export, handed an `error` and a `retry`.
 *
 * What must hold: it says what happened and what to do; it never shows the error's own text (this boundary
 * wraps sign-in too, where nothing may echo what it was handed); Reload and Try again each do their one thing.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppError from "@/app/error";
import UiError from "@/app/(ui)/error";
import { PAGE_FAILED, PageFailed } from "@/app/(ui)/_components/PageFailed";

afterEach(cleanup);

const thrown = () =>
  Object.assign(new Error("refresh_token=abc123 was rejected"), { digest: "1234567890" });

describe("UIL-106 · a page that throws ends in words she can act on", () => {
  it("says what happened and what to do, and names its reference", () => {
    render(createElement(AppError, { error: thrown(), retry: vi.fn() }));
    const box = screen.getByRole("alert");
    expect(box.textContent).toContain(PAGE_FAILED.title);
    expect(box.textContent).toContain(PAGE_FAILED.body);
    expect(box.textContent).toContain("Reference: 1234567890");
  });

  it("never shows the error's own text", () => {
    render(createElement(AppError, { error: thrown(), retry: vi.fn() }));
    expect(document.body.textContent).not.toContain("refresh_token");
    expect(document.body.textContent).not.toContain("abc123");
  });

  it("claims no cause and nothing about what was saved", () => {
    // A boundary catches a bug as readily as a redeploy, so the cause is an "if", never a statement.
    expect(PAGE_FAILED.body).toMatch(/\bIf the app was updated\b/);
    expect(`${PAGE_FAILED.title} ${PAGE_FAILED.body}`).not.toMatch(/saved/i);
  });

  it("'Try again' asks Next to re-render the page; 'Reload the page' reloads it", async () => {
    const retry = vi.fn();
    const reload = vi.fn();
    const user = userEvent.setup();
    render(createElement(PageFailed, { retry, reload }));

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reload the page" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("no reference line when there is no digest", () => {
    render(createElement(AppError, { error: new Error("x"), retry: vi.fn() }));
    expect(screen.getByRole("alert").textContent).not.toContain("Reference");
  });

  it("a screen that throws gets the same boundary, inside the app frame", () => {
    expect(UiError).toBe(AppError);
  });
});
