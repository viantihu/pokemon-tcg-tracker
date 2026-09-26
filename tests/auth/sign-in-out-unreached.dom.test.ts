// @vitest-environment jsdom
/**
 * UIL-106's last two sites — Sign in and Sign out — when the call cannot reach the server at all.
 *
 * Before this, both threw to the app's error page (UIL-106 part 4's boundary; Next's default page before
 * that): a magic-link request or a Sign out pressed in a tab left open across a redeploy, or on a dropped
 * connection. Both now go through the shared `reach` and say so where she pressed. Driven through the REAL
 * components in a DOM, with the server action scripted to reject.
 *
 * THE TRAP THIS ALSO PINS. Sign out SUCCEEDS by calling `redirect("/login")`, and in Next 16 a server action's
 * redirect reaches the browser as a REJECTED promise carrying Next's redirect error, for Next's own boundary
 * to navigate on. `reach` catches rejections, so without `unstable_rethrow` it would have turned every
 * successful Sign out into "the connection dropped". Pinned both at `reach` itself and through the button.
 */
import { Component, createElement, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { redirect, notFound } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reach } from "@/app/(ui)/_components/reach";
import { SignOutButton } from "@/app/(ui)/_components/SignOutButton";
import { LoginForm } from "@/app/login/LoginForm";
import { SIGN_IN_UNREACHED, SIGN_OUT_UNREACHED } from "@/app/login/messages";

const signIn = vi.fn();
const signOut = vi.fn();
vi.mock("@/app/login/actions", () => ({
  signIn: (...a: unknown[]) => signIn(...a),
  signOut: (...a: unknown[]) => signOut(...a),
}));

/** What Next's own `redirect()` throws: a real one, not a lookalike. */
function nextRedirectError(): unknown {
  try {
    redirect("/login");
  } catch (e) {
    return e;
  }
  throw new Error("redirect() did not throw");
}
function nextNotFoundError(): unknown {
  try {
    notFound();
  } catch (e) {
    return e;
  }
  throw new Error("notFound() did not throw");
}

/** Stands in for Next's RedirectBoundary: records what an action threw to the nearest boundary. */
class Catcher extends Component<
  { onError: (e: unknown) => void; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const LOST = () => new TypeError("Failed to fetch");

beforeEach(() => {
  signIn.mockReset();
  signOut.mockReset();
});
afterEach(cleanup);

describe("reach hands Next's own signals back, and turns only a real failure into words", () => {
  it("a redirect passes through unchanged", async () => {
    const err = nextRedirectError();
    await expect(reach(() => Promise.reject(err), "lost")).rejects.toBe(err);
  });

  it("so does a not-found", async () => {
    const err = nextNotFoundError();
    await expect(reach(() => Promise.reject(err), "lost")).rejects.toBe(err);
  });

  it("a call that never arrived becomes the message", async () => {
    await expect(reach(() => Promise.reject(LOST()), "lost")).resolves.toEqual({
      ok: false,
      error: "lost",
      unreached: true,
    });
  });
});

describe("Sign in that cannot reach the server", () => {
  it("says so on the form, where a refusal shows, and she can send again", async () => {
    signIn.mockRejectedValue(LOST());
    const user = userEvent.setup();
    render(createElement(LoginForm));
    await user.type(screen.getByLabelText("Owner email"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Send magic link" }));

    // PRE-FIX: the throw went to the app's error page.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SIGN_IN_UNREACHED));
    expect(
      (screen.getByRole("button", { name: "Send magic link" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("an answer the server gives is still shown as it was: sent, or its own refusal", async () => {
    signIn.mockResolvedValueOnce({
      status: "error",
      message: "That email is not authorised for this binder.",
    });
    const user = userEvent.setup();
    render(createElement(LoginForm));
    await user.type(screen.getByLabelText("Owner email"), "someone@example.com");
    await user.click(screen.getByRole("button", { name: "Send magic link" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That email is not authorised for this binder.",
      ),
    );

    signIn.mockResolvedValueOnce({ status: "sent", email: "owner@example.com" });
    await user.clear(screen.getByLabelText("Owner email"));
    await user.type(screen.getByLabelText("Owner email"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Send magic link" }));
    await waitFor(() => expect(screen.getByText("Check your email")).toBeTruthy());
  });
});

describe("Sign out that cannot reach the server", () => {
  it("says so beside the button, instead of the error page", async () => {
    signOut.mockRejectedValue(LOST());
    const caught = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(
        Catcher,
        { onError: caught },
        createElement(SignOutButton, { email: "o@x.dev" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SIGN_OUT_UNREACHED));
    expect(caught).not.toHaveBeenCalled(); // PRE-FIX: the throw reached the boundary
  });

  it("a Sign out that WORKS still hands its redirect to Next, and says nothing about a dropped connection", async () => {
    const err = nextRedirectError();
    signOut.mockRejectedValue(err);
    const caught = vi.fn();
    const onError = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      createElement(
        Catcher,
        { onError: caught },
        createElement(SignOutButton, { email: "o@x.dev" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    // The redirect reached the boundary, as in the app it reaches Next's RedirectBoundary, which navigates.
    await waitFor(() => expect(caught).toHaveBeenCalledWith(err));
    expect(screen.queryByText(SIGN_OUT_UNREACHED)).toBeNull();
    onError.mockRestore();
  });
});
