import type { Metadata } from "next";
import DepositorMonitor from "./monitor";

export const metadata: Metadata = {
  title: { absolute: "Lido Depositor Watch" },
  description: "Live Lido deposit and top-up activity, buffer capacity, depositor balances and EDF delegation on Ethereum Mainnet and Hoodi.",
};

export default function DepositorPage() { return <DepositorMonitor />; }
