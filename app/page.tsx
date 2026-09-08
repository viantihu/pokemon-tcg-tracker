import { redirect } from "next/navigation";

/** The app opens on the haul plan — the primary daily screen (dev-spec §5 M6; system-design §8). */
export default function Home() {
  redirect("/plan");
}
