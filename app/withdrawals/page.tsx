import type { Metadata } from "next";
import WithdrawalsMonitor from "./monitor";
export const metadata:Metadata={title:{absolute:"Lido Withdrawal Watch"},description:"Lido withdrawal demand, validator exit timing, funding projections, buffer history and withdrawal finalizations on Ethereum Mainnet and Hoodi."};
export default async function WithdrawalsPage({searchParams}:{searchParams:Promise<{network?:string}>}){const query=await searchParams;return <WithdrawalsMonitor initialNetwork={query.network==='hoodi'?'hoodi':'mainnet'}/>;}
