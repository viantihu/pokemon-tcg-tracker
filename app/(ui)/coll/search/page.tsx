/**
 * Card search + bulk add route (UIL-039). Reached from the collection editor's "Search & add
 * cards" link, never from the frozen top nav — same pattern as Wishlist living behind a segmented
 * control instead of its own tab.
 */

import { redirect } from "next/navigation";
import { CardSearchGrid } from "../CardSearchGrid";

export const metadata = { title: "Search cards · Binder Ops" };

export default async function CardSearchPage({ searchParams }: PageProps<"/coll/search">) {
  const params = await searchParams;
  const collectionId = typeof params.collectionId === "string" ? params.collectionId : null;
  if (!collectionId) redirect("/coll");
  return <CardSearchGrid collectionId={collectionId} />;
}
