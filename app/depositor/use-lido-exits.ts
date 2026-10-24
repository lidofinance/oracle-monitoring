"use client";
import { DATA_REFRESH_INTERVAL_MS } from "../refresh-policy";
import { useLoadingTask } from "../loading-status";
import { rpcFetch } from "../rpc-client";
import { useEffect, useState } from "react";
import type { LidoExitBalanceHistory } from "../lido-exit-balances-data";

export function useLidoExits(network: "mainnet" | "hoodi", refreshKey: number) {
  const [state, setState] = useState<{ network: string; data: LidoExitBalanceHistory | null; failed: boolean } | null>(null);
  const [fetching,setFetching]=useState(true);
  const current=state?.network===network?state:null;
  useLoadingTask(network,"Daily Lido exit balances",fetching||(!current?.failed&&(!current?.data||current.data.status==='loading')),!!current?.failed||(current?.data?.status==='ready'&&current.data.points.some(point=>point.status!=='ready')));
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let delay = DATA_REFRESH_INTERVAL_MS;setFetching(true);
      try {
        const response = await rpcFetch(`/api/depositor?network=${network}&view=exit-balances`, { signal: controller.signal, cache: "no-store" });
        const body = await response.json() as LidoExitBalanceHistory;
        if (!response.ok || body.network !== network || !Array.isArray(body.points) || !["loading", "ready"].includes(body.status)) throw Error("Exit balances unavailable");
        if (controller.signal.aborted) return;
        setState({ network, data: body, failed: false });
        if (body.status === "loading") delay = 3000;
        else if(body.points.some(point=>point.status!=="ready"))delay=DATA_REFRESH_INTERVAL_MS;
      } catch {
        if (controller.signal.aborted) return;
        setState(previous => ({ network, data: previous?.network === network ? previous.data : null, failed: true }));
        delay=DATA_REFRESH_INTERVAL_MS;
      }
      if (!controller.signal.aborted) setFetching(false);
      if (!controller.signal.aborted) timer = setTimeout(() => { if (!document.hidden) void load(); else timer = setTimeout(load, DATA_REFRESH_INTERVAL_MS); }, delay);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [network, refreshKey]);
  return state?.network === network ? state : null;
}
