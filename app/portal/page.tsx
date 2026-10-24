import type { Metadata } from "next";
import MonitoringPortal from "./portal";

export const metadata: Metadata = {
  title: { absolute: "Lido Watch · Protocol Observatory" },
  description: "A home for Lido's onchain operations: oracles, deposits, Council guardians, validator exits and consolidations.",
  openGraph: { title: "Lido Watch · Protocol Observatory", description: "Dashboards, shortcuts and onchain operations for Mainnet and Hoodi." },
};

export default async function PortalPage({ searchParams }: { searchParams: Promise<{ network?: string }> }) {
  const query = await searchParams;
  return <MonitoringPortal initialNetwork={query.network === "hoodi" ? "hoodi" : "mainnet"} />;
}
