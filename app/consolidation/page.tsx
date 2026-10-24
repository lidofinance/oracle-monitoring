import type { Metadata } from "next";
import ConsolidationMonitor from "./monitor";
export const metadata: Metadata={title:{absolute:"Lido Consolidation Watch"},description:"Lido ConsolidationBus queue, quota recovery, execution transactions and CMv1 migration coverage on Mainnet and Hoodi."};
export default function ConsolidationPage(){return <ConsolidationMonitor/>;}
