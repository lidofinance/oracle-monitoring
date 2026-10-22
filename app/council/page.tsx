import type { Metadata } from "next";
import CouncilMonitor from "./monitor";

export const metadata: Metadata = {
  title: { absolute: "Lido Council Watch" },
  description: "Live DSM Council guardians, delegate balances on Ethereum, Gnosis and Polygon, and confirmed Council messages and transactions.",
};
export default function CouncilPage() { return <CouncilMonitor />; }
