"use client";

import { useRef, type ReactNode } from "react";
import HomeLink from "./home-link";
import RpcPicker from "./rpc-client";
import LoadingStatus from "./loading-status";
import "./site-header.css";
import "./numeric-typography.css";

type Network = "mainnet" | "hoodi";

export default function SiteHeader({ network, title, subtitle, icon, actions, navigation, home = false }: {
  network: Network;
  title: string;
  subtitle: string;
  icon: ReactNode;
  actions?: ReactNode;
  navigation?: ReactNode;
  home?: boolean;
}) {
  return <header className="site-header">
    <div className={`site-header-main${navigation ? " with-navigation" : ""}`}>
      <div className="site-header-brand">
        <HomeLink network={network} current={home} />
        <span className="site-header-icon" aria-hidden="true">{icon}</span>
        <div className="site-header-title"><strong>{title}</strong><span>{subtitle}</span></div>
      </div>
      {navigation && <div className="site-header-navigation">{navigation}</div>}
      <div className="site-header-actions"><LoadingStatus network={network} home={home}/>{actions}</div>
    </div>
  </header>;
}

export function NetworkBar({ network, onChange, label = "Network", idPrefix, panelId }: {
  network: Network;
  onChange: (network: Network) => void;
  label?: string;
  idPrefix?: string;
  panelId?: string;
}) {
  const buttons = useRef<Partial<Record<Network, HTMLButtonElement | null>>>({});
  return <div className="site-network-bar">
    <div className="site-network-tabs" role="tablist" aria-label={label}>
      {(["mainnet", "hoodi"] as const).map(n => <button key={n} type="button" role="tab"
        ref={element => { buttons.current[n] = element; }}
        id={idPrefix ? `${idPrefix}-${n}` : undefined} aria-controls={panelId}
        aria-selected={network === n} tabIndex={network === n ? 0 : -1}
        className={network === n ? "active" : ""}
        onClick={() => { if (network !== n) onChange(n); }}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "mainnet" : event.key === "End" ? "hoodi" : n === "mainnet" ? "hoodi" : "mainnet";
          if (network !== next) onChange(next);
          buttons.current[next]?.focus();
        }}>
        <i className={`site-network-dot ${n}`} aria-hidden="true" />{n === "mainnet" ? "Mainnet" : "Hoodi"}
        <small>{n === "mainnet" ? "CHAIN 1" : "TESTNET"}</small>
      </button>)}
    </div>
    <div className="site-network-status"><RpcPicker network={network}/></div>
  </div>;
}
