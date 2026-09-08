import type { MetadataRoute } from "next";

/**
 * PWA manifest so the app is installable to the phone home screen
 * (docs/devops-strategy.md §1 — installable responsive web app, no offline).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pokémon TCG Binder",
    short_name: "TCG Binder",
    description: "Routes each card to a binder and half, and tracks evolution line state.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
