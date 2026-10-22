import type { Metadata } from "next";
import Simulator from "./simulator";
export const metadata: Metadata={title:{absolute:"VEBO Exit Simulator"},description:"Explore VEBO reports, operator weights, forced and soft exits, sanity limits, and the selection predicate for each validator."};
export default function VeboSimulatorPage(){return <Simulator/>;}
