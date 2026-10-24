import { ArrowLeft, House } from "lucide-react";

export default function HomeLink({ network = "mainnet", current = false }: { network?: "mainnet" | "hoodi"; current?: boolean }) {
  if (current) return <button className="home-link" type="button" disabled aria-label="Home — current page" title="You are on the home page"><House size={15}/><span>Home</span></button>;
  return <a className="home-link" href={`https://f4ever.pl/?network=${network}`} aria-label="Back to home" title="Back to home"><ArrowLeft size={15}/><span>Home</span></a>;
}
