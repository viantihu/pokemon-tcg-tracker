"use client";

/**
 * The app-level error boundary (UIL-106 part 4). Wraps every page under the root layout, sign-in included,
 * so a throw that no screen caught (a form action like Sign out, a render that failed) ends in words she
 * can act on rather than Next's default page. See `PageFailed` for what it says and why.
 */

import { PageFailed } from "./(ui)/_components/PageFailed";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <PageFailed retry={retry} digest={error.digest} />;
}
