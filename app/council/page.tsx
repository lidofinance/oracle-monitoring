import type { Metadata } from "next";
import CouncilMonitor from "./monitor";

export const metadata: Metadata = {
  title: { absolute: "Lido Council Watch" },
  description: "Mainnet and Hoodi DSM Council guardians, delegate balances, DataBus broadcasts, and confirmed Council transactions.",
};
export default function CouncilPage() { return <CouncilMonitor />; }
