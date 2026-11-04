"use client";
import { DATA_REFRESH_INTERVAL_MS } from "./refresh-policy";

import SiteHeader, { NetworkBar } from "./site-header";
import { useLoadingTask } from "./loading-status";
import { useAutoRetry } from "./use-auto-retry";
import { rpcFetch, readRpcChoiceRaw, subscribeRpcChoice } from "./rpc-client";
import { parseRpcChoice, RPC_OPTIONS } from "./rpc-selection";
import type { OracleSnapshotResult } from "./oracle-snapshot-cache";
import { waitForRetry } from "./request-retry";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileJson,
  ListTree,
  LoaderCircle,
  Maximize2,
  Radio,
  RefreshCw,
  Search,
  ServerCog,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { voteStateFor, type FrameInfo } from "./oracle-consensus";
import { filterWithCounts, parseSelection, toggleSelection } from "./filters";
import {
  ORACLE_MODULES,
  TELEMETRY_EVENT_KINDS,
  availableModules,
  telemetryReadiness,
  type OracleModule,
  type TelemetryEvent,
} from "./oracle-modules";
import {
  DEFAULT_HASH_VOTE_FRAMES,
  HASH_VOTE_FRAMES,
  REPORT_PHASES,
  frameKey,
  frameReports,
  safeHashVoteFrames,
  type ParsedOracleReport,
  type ReportPhase,
} from "./oracle-reports";
import { NETWORKS, LABELS, HOLDER_CONTRACTS, DATABUS_EXPLORER, type Holder, type SeatKind, type BusMessage, type Snapshot } from "./oracle-snapshot-data";

type NetworkKey = "mainnet" | "hoodi";
type ViewKey = "overview" | "telemetry" | "oracle";
type ModuleKey = OracleModule;

type OracleReportsPayload = {
  contracts: Partial<Record<ModuleKey, string>>;
  reports: ParsedOracleReport[];
  // Set when a part of the report history could not be read.
  warnings?: string[];
};

// A transaction is listed once per phase and module.
function reportKey(report: ParsedOracleReport) {
  return `${report.phase}:${report.module}:${report.transactionHash}`;
}

// Filters kept in the URL. Telemetry has modules, event kinds, holders and a
// search query; oracle reports have modules, phases, holders and the hash
// vote depth. Holders are DelegationContract addresses. The lists are
// multi-select filters, see filters.ts.
type RouteFilters = {
  modules: ModuleKey[];
  events: TelemetryEvent[];
  telemetryHolders: string[];
  query: string;
  oracleModules: ModuleKey[];
  phases: ReportPhase[];
  holders: string[];
  frames: number;
};

const REPORT_PHASE_KEYS = REPORT_PHASES.map(({ key }) => key);
const TELEMETRY_EVENT_KEYS = TELEMETRY_EVENT_KINDS.map(({ key }) => key);

const MODULES = ORACLE_MODULES;
const STALE_SECONDS = 24 * 60 * 60;
const LOW_BALANCE_ETH = 0.4;
const VIEW_ROUTES: Record<ViewKey, string> = { overview: "/overview", telemetry: "/telemetry", oracle: "/reports" };

function shorten(value: string, head = 6, tail = 4) {
  return `${value.slice(0, head + 2)}…${value.slice(-tail)}`;
}

function plural(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function relativeTime(seconds: number) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), "min")} ago`;
  if (seconds < 86400) return `${plural(Math.floor(seconds / 3600), "hr")} ago`;
  return `${plural(Math.floor(seconds / 86400), "day")} ago`;
}

function formatBalance(balanceEth: number) {
  if (balanceEth === 0) return "0";
  if (balanceEth < 0.0001) return "<0.0001";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: balanceEth < 1 ? 4 : 3,
  }).format(balanceEth);
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function viewFromPath(pathname: string | null): ViewKey {
  if (pathname?.startsWith("/telemetry")) return "telemetry";
  if (pathname?.startsWith("/reports")) return "oracle";
  return "overview";
}

function safeNetwork(value: string | null): NetworkKey {
  return value === "hoodi" || value === "mainnet" ? value : "mainnet";
}

function moduleKeysFor(network: NetworkKey): ModuleKey[] {
  return availableModules(NETWORKS[network].consensus).map(({ key }) => key);
}

// Holder behind a report sender. Current seats are resolved from the chain;
// a legacy EOA that already left the committee is matched by operator label.
function holderContractFor(
  network: NetworkKey,
  sender: string,
  holderByMember: Map<string, Holder>,
) {
  const label = LABELS[sender];
  return (
    holderByMember.get(sender)?.contract ??
    (label
      ? HOLDER_CONTRACTS[network].find((contract) => LABELS[contract] === label)
      : undefined)
  );
}

function formatDuration(seconds: number) {
  if (seconds % 86400 === 0) return plural(seconds / 86400, "day");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "min");
  return plural(seconds, "sec");
}

function AddressLink({
  address,
  explorer,
  head = 8,
  tail = 6,
}: {
  address: string;
  explorer: string;
  head?: number;
  tail?: number;
}) {
  return (
    <a
      className="address-link"
      href={`${explorer}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {shorten(address, head, tail)}
      <ExternalLink size={11} />
    </a>
  );
}

function ModulePill({ module }: { module: ModuleKey | "unknown" }) {
  const label =
    MODULES.find((item) => item.key === module)?.label ?? "Unknown";
  return <span className={`module-pill module-${module}`}>{label}</span>;
}

function eventLabel(event: TelemetryEvent) {
  return TELEMETRY_EVENT_KINDS.find((item) => item.key === event)?.label ?? "Other";
}

function TelemetryReadiness({ module, message, frame }: { module: ModuleKey | "unknown"; message?: BusMessage; frame?: FrameInfo }) {
  if (!["csm", "csm_0x02", "cm"].includes(module)) return null;
  const value = message ? telemetryReadiness(message.raw, module, frame?.epochsPerFrame) : null;
  const label = module === "cm" ? "CMv2" : MODULES.find(item => item.key === module)?.label;
  const inactive = frame && "notStarted" in frame;
  const stale = !!message && message.ageSeconds > STALE_SECONDS;
  return <div className={`readiness ${stale ? "stale" : ""}`}>
    <div className="readiness-heading"><span>Data ready</span><strong>{!inactive && value ? `${Math.floor(value.percent * 10) / 10}%` : "—"}</strong></div>
    {!inactive && value ? <>
      <div className="readiness-track" role="progressbar" aria-label={`${label} data readiness`} aria-valuemin={0} aria-valuemax={value.total} aria-valuenow={value.ready} aria-valuetext={`${value.ready.toLocaleString()} of ${value.total.toLocaleString()} epochs ready`}>
        <span style={{ width: `${value.percent}%` }} />
      </div>
      <span className="readiness-count">{value.ready.toLocaleString()} / {value.total.toLocaleString()} epochs</span>
    </> : <span className="readiness-count">{inactive ? "Frame has not started" : !message ? "No diagnostic telemetry" : !frame?.epochsPerFrame ? "Frame size unavailable" : "Ready value unavailable"}</span>}
    {message && <a className="readiness-source" href={`${DATABUS_EXPLORER}/tx/${message.transactionHash}`} target="_blank" rel="noreferrer" title={formatTime(message.timestamp)}>{stale ? "Stale diagnostic" : "Diagnostic"} · {relativeTime(message.ageSeconds)} <ExternalLink size={9} /></a>}
  </div>;
}

type FilterOption<T extends string> = {
  value: T;
  label: string;
  title?: string;
};

// A toolbar button that opens a menu below it. The menu closes on a click
// outside and on Escape.
function Dropdown({
  label,
  value,
  active = false,
  children,
}: {
  label: string;
  // Short text of the current choice, shown on the button.
  value: string;
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="filter-menu" ref={root}>
      <button
        type="button"
        className={`filter-menu-button${active ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label} <strong>{value}</strong>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="filter-menu-list" role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// A multi-select filter: a menu of options with the number of items behind
// every option. The button shows what is selected.
function FilterMenu<T extends string>({
  label,
  options,
  selected,
  counts,
  onChange,
}: {
  label: string;
  options: FilterOption<T>[];
  selected: readonly T[];
  counts: Map<string, number>;
  onChange: (selected: T[]) => void;
}) {
  const values = options.map(({ value }) => value);
  const chosen = options.filter(({ value }) => selected.includes(value));
  const summary = !chosen.length
    ? "All"
    : chosen.length > 2
      ? `${chosen.length} selected`
      : chosen.map((option) => option.label).join(", ");
  return (
    <Dropdown label={label} value={summary} active={chosen.length > 0}>
      {(close) => (
        <>
          {options.map(({ value, label: text, title }) => {
            const checked = selected.includes(value);
            const count = counts.get(value) ?? 0;
            return (
              <button
                type="button"
                key={value}
                role="menuitemcheckbox"
                aria-checked={checked}
                className={count ? "" : "empty"}
                title={title}
                onClick={() => onChange(toggleSelection(selected, value, values))}
              >
                <span className="filter-menu-box">
                  {checked && <Check size={11} />}
                </span>
                {text}
                <small>{count.toLocaleString()}</small>
              </button>
            );
          })}
          <footer>
            <button
              type="button"
              disabled={!selected.length}
              onClick={() => onChange([])}
            >
              Clear
            </button>
            <button type="button" onClick={close}>
              Done
            </button>
          </footer>
        </>
      )}
    </Dropdown>
  );
}

function PhasePill({ phase }: { phase: ReportPhase }) {
  const item = REPORT_PHASES.find(({ key }) => key === phase);
  return (
    <span className={`module-pill phase-${phase}`} title={item?.full}>
      {item?.label ?? phase}
    </span>
  );
}

function BalanceChip({
  label,
  address,
  balanceEth,
  explorer,
}: {
  label: string;
  address?: string;
  balanceEth?: number;
  explorer: string;
}) {
  const low = balanceEth === undefined || balanceEth < LOW_BALANCE_ETH;
  return (
    <a
      className={`wallet-chip ${low ? "low" : "funded"}`}
      href={address ? `${explorer}/address/${address}` : undefined}
      target="_blank"
      rel="noreferrer"
      title={
        address
          ? `${label}: ${address}`
          : `${label}: no telemetry sender seen in the last 7 days`
      }
    >
      <span>{label}</span>
      <strong>
        {balanceEth === undefined ? "n/a" : `${formatBalance(balanceEth)} ETH`}
      </strong>
    </a>
  );
}

function CopyButton({
  value,
  onCopied,
  label = "Copy message",
}: {
  value: string;
  onCopied: () => void;
  label?: string;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        onCopied();
      }}
    >
      <Copy size={15} />
    </button>
  );
}

function JsonModal({
  message,
  onClose,
  onCopied,
}: {
  message: BusMessage;
  onClose: () => void;
  onCopied: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="json-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Message payload"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <div className="eyebrow">DataBus payload</div>
            <h2>
              Block {message.blockNumber.toLocaleString()}{" "}
              <ModulePill module={message.module} />
            </h2>
          </div>
          <div className="modal-actions">
            <CopyButton
              value={message.pretty}
              onCopied={onCopied}
              label="Copy formatted JSON"
            />
            <button
              className="icon-button"
              type="button"
              onClick={onClose}
              aria-label="Close payload"
              title="Close"
            >
              <X size={17} />
            </button>
          </div>
        </header>
        <pre className="json-view">{message.pretty}</pre>
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={22} />
      <div>
        <strong>Reading onchain state</strong>
        <span>Members, wallet balances, and seven days of DataBus telemetry</span>
      </div>
    </div>
  );
}

// The transactions of one report phase inside the frame summary. A click
// opens the transaction in the inspector.
function FramePhase({
  phase,
  summary,
  reports,
  current,
  empty,
  onSelect,
}: {
  phase: ReportPhase;
  summary?: string;
  reports: ParsedOracleReport[];
  current: ParsedOracleReport;
  // Shown when the frame has no transaction of this phase.
  empty: string;
  onSelect: (report: ParsedOracleReport) => void;
}) {
  return (
    <div className="frame-phase">
      <span>
        <PhasePill phase={phase} />
        {summary}
      </span>
      {reports.length ? (
        <div className="frame-items">
          {reports.map((item) => (
            <button
              type="button"
              key={reportKey(item)}
              className={[
                "frame-item",
                reportKey(item) === reportKey(current) ? "active" : "",
                item.consensusMatch === false ? "differs" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={[
                `Block ${item.blockNumber.toLocaleString()}`,
                formatTime(item.timestamp),
                item.consensusMatch === false ? "Differs from consensus" : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              aria-pressed={reportKey(item) === reportKey(current)}
              onClick={() => onSelect(item)}
            >
              {LABELS[item.sender] ?? shorten(item.sender, 6, 4)}
            </button>
          ))}
        </div>
      ) : (
        <small>{empty}</small>
      )}
    </div>
  );
}

function OracleReportInspector({
  report,
  frame,
  committeeSize,
  hashVoteFrames,
  explorer,
  onCopied,
  onSelect,
}: {
  report: ParsedOracleReport;
  // All loaded transactions of the report frame, by phase.
  frame: Record<ReportPhase, ParsedOracleReport[]>;
  // Members of the module committee, when known.
  committeeSize?: number;
  hashVoteFrames: number;
  explorer: string;
  onCopied: () => void;
  onSelect: (report: ParsedOracleReport) => void;
}) {
  const voters = new Set(frame.hash.map((vote) => vote.sender)).size;
  return (
    <>
      <header className="inspector-header">
        <div>
          <div className="eyebrow">
            {REPORT_PHASES.find(({ key }) => key === report.phase)?.full ??
              "Consensus report"}
          </div>
          <h2>Block {report.blockNumber.toLocaleString()}</h2>
        </div>
        <div className="inspector-actions">
          <CopyButton
            value={report.rawJson}
            onCopied={onCopied}
            label="Copy decoded report"
          />
          <a
            className="icon-button"
            href={`${explorer}/tx/${report.transactionHash}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open transaction"
            title="Open transaction"
          >
            <ExternalLink size={15} />
          </a>
        </div>
      </header>

      <div className="report-metadata">
        <div>
          <span>Module</span>
          <ModulePill module={report.module} />
        </div>
        <div>
          <span>{report.phase === "hash" ? "Voted by" : "Submitted by"}</span>
          <strong>{LABELS[report.sender] ?? shorten(report.sender, 7, 5)}</strong>
        </div>
        <div>
          <span>Observed</span>
          <strong>{formatTime(report.timestamp)}</strong>
        </div>
        <div>
          <span>{report.phase === "hash" ? "HashConsensus" : "Receiver"}</span>
          <a
            href={`${explorer}/address/${report.receiver}`}
            target="_blank"
            rel="noreferrer"
          >
            {shorten(report.receiver, 8, 6)}
            <ExternalLink size={12} />
          </a>
        </div>
      </div>

      <section className="report-frame" aria-label="Frame transactions">
        <header>
          Frame · slot {report.refSlot.toLocaleString()}
        </header>
        <FramePhase
          phase="hash"
          summary={
            frame.hash.length
              ? `${voters}${committeeSize ? ` of ${committeeSize}` : ""} members`
              : undefined
          }
          reports={frame.hash}
          current={report}
          empty={`Not loaded: hash votes cover the latest ${hashVoteFrames} frames`}
          onSelect={onSelect}
        />
        <FramePhase
          phase="data"
          reports={frame.data}
          current={report}
          empty="No report data transaction found"
          onSelect={onSelect}
        />
        <FramePhase
          phase="extra"
          reports={frame.extra}
          current={report}
          empty={
            report.module === "ao"
              ? "No extra data transaction found"
              : "This module has no extra data phase"
          }
          onSelect={onSelect}
        />
      </section>

      <div className="decoded-fields">
        {report.fields.map((field) => (
          <div className="decoded-field" key={field.label}>
            <span>{field.label}</span>
            <strong className={field.mono ? "mono" : ""}>{field.value}</strong>
            <p>{field.description}</p>
          </div>
        ))}
      </div>

      {report.veboOperators && (
        <section className="vebo-breakdown">
          <header>
            <div>
              <h3>Exit demand by operator</h3>
              <p>
                Nominal ETH uses 32 ETH per validator; calldata does not include
                live validator balances.
              </p>
            </div>
            <strong>
              {report.veboOperators.reduce(
                (total, operator) => total + operator.nominalEth,
                0,
              )}{" "}
              ETH
            </strong>
          </header>
          <div className="vebo-table-scroll">
            <table className="vebo-table">
              <thead>
                <tr>
                  <th>Staking module</th>
                  <th>Operator</th>
                  <th>Validators</th>
                  <th>Nominal ETH</th>
                  <th>Validator indices</th>
                </tr>
              </thead>
              <tbody>
                {report.veboOperators.map((operator) => (
                  <tr key={`${operator.moduleId}-${operator.operatorId}`}>
                    <td>Module {operator.moduleId}</td>
                    <td>
                      <strong>{operator.operatorName || "Unnamed operator"}</strong>
                      <small>Operator #{operator.operatorId}</small>
                    </td>
                    <td>{operator.validatorCount}</td>
                    <td>{operator.nominalEth} ETH</td>
                    <td title={operator.validatorIndices.join(", ")}>
                      {operator.validatorIndices.slice(0, 5).join(", ")}
                      {operator.validatorIndices.length > 5
                        ? ` +${operator.validatorIndices.length - 5}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export default function OracleMonitor() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [network, setNetwork] = useState<NetworkKey>("mainnet");
  const [view, setView] = useState<ViewKey>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [openMessage, setOpenMessage] = useState<BusMessage | null>(null);
  const [selectedReport, setSelectedReport] = useState<BusMessage | null>(null);
  // Multi-select filters: an empty list means the filter is off.
  const [moduleFilter, setModuleFilter] = useState<ModuleKey[]>([]);
  const [eventFilter, setEventFilter] = useState<TelemetryEvent[]>([]);
  const [telemetryHolderFilter, setTelemetryHolderFilter] = useState<string[]>(
    [],
  );
  const [oracleModuleFilter, setOracleModuleFilter] = useState<ModuleKey[]>([]);
  const [oraclePhaseFilter, setOraclePhaseFilter] = useState<ReportPhase[]>([]);
  const [oracleHolderFilter, setOracleHolderFilter] = useState<string[]>([]);
  const [hashVoteFrames, setHashVoteFrames] = useState(
    DEFAULT_HASH_VOTE_FRAMES,
  );
  // Report API responses by network and hash vote depth.
  const [oraclePayloads, setOraclePayloads] = useState<
    Partial<Record<string, OracleReportsPayload>>
  >({});
  const [reportRetry,setReportRetry]=useState(0);
  const reportRetryUsed=useRef<Record<string,number>>({});
  const [oracleLoading, setOracleLoading] = useState(false);
  const [oracleError, setOracleError] = useState<string | null>(null);
  const [selectedOracleReport, setSelectedOracleReport] =
    useState<ParsedOracleReport | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState(false);

  useLoadingTask(network,"Oracle members and telemetry",loading,!!error||!!snapshot?.[network].warnings.length);
  useLoadingTask(network,"Oracle reports",view==="oracle"&&(oracleLoading||(!oraclePayloads[`${network}:${hashVoteFrames}`]&&!oracleError)),view==="oracle"&&(!!oracleError||!!oraclePayloads[`${network}:${hashVoteFrames}`]?.warnings?.length));
  const routeFor = useCallback(
    (
      nextView: ViewKey,
      nextNetwork = network,
      overrides: Partial<RouteFilters> = {},
    ) => {
      const filters: RouteFilters = {
        modules: moduleFilter,
        events: eventFilter,
        telemetryHolders: telemetryHolderFilter,
        query,
        oracleModules: oracleModuleFilter,
        phases: oraclePhaseFilter,
        holders: oracleHolderFilter,
        frames: hashVoteFrames,
        ...overrides,
      };
      const params = new URLSearchParams();
      params.set("network", nextNetwork);
      const setList = (name: string, values: readonly string[]) => {
        if (values.length) params.set(name, values.join(","));
      };
      // Modules and holders differ per network, so the ones missing on the
      // next network do not survive a switch.
      const networkModules = moduleKeysFor(nextNetwork);
      const networkHolders = (holders: readonly string[]) =>
        holders.filter((holder) =>
          HOLDER_CONTRACTS[nextNetwork].includes(holder),
        );
      if (nextView === "telemetry") {
        setList(
          "module",
          filters.modules.filter((key) => networkModules.includes(key)),
        );
        setList("event", filters.events);
        setList("holder", networkHolders(filters.telemetryHolders));
        if (filters.query.trim()) params.set("search", filters.query.trim());
      }
      if (nextView === "oracle") {
        setList(
          "module",
          filters.oracleModules.filter((key) => networkModules.includes(key)),
        );
        setList("phase", filters.phases);
        setList("holder", networkHolders(filters.holders));
        if (filters.frames !== DEFAULT_HASH_VOTE_FRAMES) {
          params.set("frames", String(filters.frames));
        }
      }
      // Keep the commas of the lists readable.
      return `${VIEW_ROUTES[nextView]}?${params.toString().replaceAll("%2C", ",")}`;
    },
    [
      eventFilter,
      hashVoteFrames,
      moduleFilter,
      network,
      oracleHolderFilter,
      oracleModuleFilter,
      oraclePhaseFilter,
      query,
      telemetryHolderFilter,
    ],
  );

  // The URL is the source of truth for the view, network and filters. The
  // state is adjusted during render when the route changes, so the first
  // render of a new route already shows the right screen.
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [syncedRouteKey, setSyncedRouteKey] = useState<string | null>(null);
  if (syncedRouteKey !== routeKey) {
    setSyncedRouteKey(routeKey);
    const nextView = viewFromPath(pathname);
    const nextNetwork = safeNetwork(searchParams.get("network"));
    const nextModules = parseSelection(
      searchParams.get("module"),
      moduleKeysFor(nextNetwork),
    );
    const nextQuery = searchParams.get("search") ?? searchParams.get("q") ?? "";
    const nextHolders = parseSelection(
      searchParams.get("holder"),
      HOLDER_CONTRACTS[nextNetwork],
    );
    setView(nextView);
    setNetwork(nextNetwork);
    if (nextView === "telemetry") {
      setModuleFilter(nextModules);
      setEventFilter(
        parseSelection(searchParams.get("event"), TELEMETRY_EVENT_KEYS),
      );
      setTelemetryHolderFilter(nextHolders);
      setQuery(nextQuery);
    } else {
      setQuery("");
    }
    if (nextView === "oracle") {
      setOracleModuleFilter(nextModules);
      setOraclePhaseFilter(
        parseSelection(searchParams.get("phase"), REPORT_PHASE_KEYS),
      );
      setOracleHolderFilter(nextHolders);
      setHashVoteFrames(safeHashVoteFrames(searchParams.get("frames")));
    }
    setSelectedReport(null);
    setSelectedOracleReport(null);
  }

  const navigate = useCallback(
    (
      nextView: ViewKey,
      nextNetwork = network,
      overrides?: Partial<RouteFilters>,
    ) => {
      // The route sync above runs only after the navigation commits. Apply a
      // new selection right away, so the chips respond at once and a quick
      // second click builds on the first one.
      if (overrides?.modules) setModuleFilter(overrides.modules);
      if (overrides?.events) setEventFilter(overrides.events);
      if (overrides?.telemetryHolders)
        setTelemetryHolderFilter(overrides.telemetryHolders);
      if (overrides?.oracleModules) setOracleModuleFilter(overrides.oracleModules);
      if (overrides?.phases) setOraclePhaseFilter(overrides.phases);
      if (overrides?.holders) setOracleHolderFilter(overrides.holders);
      router.push(routeFor(nextView, nextNetwork, overrides));
    },
    [network, routeFor, router],
  );

  const rpcChoiceRaw = useSyncExternalStore(
    subscribeRpcChoice,
    readRpcChoiceRaw,
    () => "",
  );
  const rpcChoice = useMemo(() => parseRpcChoice(rpcChoiceRaw), [rpcChoiceRaw]);

  const collectionController = useRef<AbortController|null>(null);
  const load = useCallback(async () => {
    collectionController.current?.abort();
    const controller=new AbortController();collectionController.current=controller;
    setLoading(true);setError(null);
    const mode=view==='telemetry'?'telemetry':'overview';
    const headers=new Headers();
    for(const n of ['mainnet','hoodi'] as const){const preset=RPC_OPTIONS[n].find(option=>option.url===rpcChoice[n]);if(preset)headers.set(`x-lido-${n}-rpc`,preset.id);}
    const prefix=window.location.pathname.startsWith('/oracle')?'/oracle':'';
    try {
      for(;;){
        const response=await rpcFetch(`${prefix}/api/oracle-snapshot?network=${network}&mode=${mode}`,{headers,signal:controller.signal});
        const next=await response.json() as OracleSnapshotResult;
        if(!response.ok||next.status==='error')throw new Error(next.error??'Could not load Oracle data.');
        if(controller.signal.aborted)return;
        if(next.snapshot){setSnapshot(next.snapshot);setUpdatedAt(new Date(next.storedAt));}
        if(next.status==='ready')break;
        await waitForRetry(2000,controller.signal);
      }
    } catch(loadError){
      if(!controller.signal.aborted)setError(loadError instanceof Error?loadError.message:'Unable to load onchain state');
    } finally {if(!controller.signal.aborted)setLoading(false);}
  },[rpcChoice,network,view]);
  useEffect(()=>{
    const initial=setTimeout(()=>void load(),0);
    const timer=setInterval(()=>{if(!document.hidden)void load();},DATA_REFRESH_INTERVAL_MS);
    return()=>{clearTimeout(initial);clearInterval(timer);collectionController.current?.abort();};
  },[load]);

  const oraclePayloadKey = `${network}:${hashVoteFrames}`;
  useAutoRetry(view==='oracle'&&(!!oracleError||!!oraclePayloads[oraclePayloadKey]?.warnings?.length),oracleLoading,()=>setReportRetry(n=>n+1),`${oraclePayloadKey}:${view}`);
  useEffect(() => {
    if (view !== "oracle" || (oraclePayloads[oraclePayloadKey]&&(reportRetryUsed.current[oraclePayloadKey]??0)===reportRetry)) {
      const idle=window.setTimeout(()=>setOracleLoading(false),0);
      return()=>window.clearTimeout(idle);
    }
    reportRetryUsed.current[oraclePayloadKey]=reportRetry;
    const controller = new AbortController();
    const start = window.setTimeout(() => {
      setOracleLoading(true);
      setOracleError(null);
      rpcFetch(`/api/oracle-reports?network=${network}&frames=${hashVoteFrames}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json()) as
            | OracleReportsPayload
            | { error?: string };
          if (!response.ok || !("reports" in payload)) {
            throw new Error(
              "error" in payload && payload.error
                ? payload.error
                : "Unable to load oracle reports",
            );
          }
          setOraclePayloads((current) => ({
            ...current,
            [oraclePayloadKey]: payload,
          }));
        })
        .catch((loadError) => {
          if (
            loadError instanceof DOMException &&
            loadError.name === "AbortError"
          )
            return;
          setOracleError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load oracle reports",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setOracleLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(start);
      controller.abort();
    };
  }, [hashVoteFrames, network, oraclePayloadKey, oraclePayloads, view, reportRetry]);

  const copied = useCallback(() => {
    setToast(true);
    window.setTimeout(() => setToast(false), 1600);
  }, []);

  const data = snapshot?.[network] ?? null;
  const memberMessages = useMemo(() => {
    if (!data) return new Map<string, Map<ModuleKey, BusMessage>>();
    const map = new Map<string, Map<ModuleKey, BusMessage>>();
    for (const message of data.messages) {
      // A startup alone is not a heartbeat: an oracle that keeps restarting
      // without reporting must show as stale.
      if (
        message.module === "unknown" ||
        message.event === "startup" ||
        !message.memberAddress
      )
        continue;
      const modules = map.get(message.memberAddress) ?? new Map();
      if (!modules.has(message.module)) modules.set(message.module, message);
      map.set(message.memberAddress, modules);
    }
    return map;
  }, [data]);

  const readinessMessages = useMemo(() => {
    const map = new Map<string, Map<ModuleKey, BusMessage>>();
    for (const message of data?.messages ?? []) {
      if (message.module === "unknown" || message.event !== "diagnostic") continue;
      for (const address of [message.memberAddress, message.holderAddress]) {
        if (!address) continue;
        const modules = map.get(address) ?? new Map<ModuleKey, BusMessage>();
        const previous = modules.get(message.module);
        if (!previous || message.timestamp > previous.timestamp || (message.timestamp === previous.timestamp && message.blockNumber > previous.blockNumber)) modules.set(message.module, message);
        map.set(address, modules);
      }
    }
    return map;
  }, [data]);

  const networkModules = useMemo(
    () => availableModules(NETWORKS[network].consensus),
    [network],
  );
  // Latest startup message per member and module: carries the Keys API
  // version and the DelegationContract the oracle was configured with.
  // Latest message and latest startup per holder and module. Startups carry
  // the Keys API version; heartbeats exclude startups.
  const holderTelemetry = useMemo(() => {
    const latest = new Map<string, Map<ModuleKey, BusMessage>>();
    const startups = new Map<string, Map<ModuleKey, BusMessage>>();
    if (!data) return { latest, startups };
    for (const message of data.messages) {
      if (message.module === "unknown" || !message.holderAddress) continue;
      const target = message.event === "startup" ? startups : latest;
      const modules =
        target.get(message.holderAddress) ?? new Map<ModuleKey, BusMessage>();
      if (!modules.has(message.module)) modules.set(message.module, message);
      target.set(message.holderAddress, modules);
    }
    return { latest, startups };
  }, [data]);

  // Holder (DelegationContract) behind each member row: the contract itself,
  // its delegate key, or a legacy EOA of the same operator.
  const holderByMember = useMemo(() => {
    const map = new Map<string, Holder>();
    if (!data) return map;
    for (const holder of data.holders) {
      for (const sender of holder.senders) {
        if (!map.has(sender)) map.set(sender, holder);
      }
    }
    return map;
  }, [data]);
  const nowSeconds = Math.floor((updatedAt?.getTime() ?? 0) / 1000);

  // Members that did not vote for the current or the previous frame.
  const missedReportCount = useMemo(() => {
    if (!data) return 0;
    return data.members.reduce(
      (total, member) =>
        total +
        networkModules.filter(
          ({ key }) =>
            member.lastSlots[key] !== undefined &&
            voteStateFor(member.lastSlots[key], data.frames[key]) === "missed",
        ).length,
      0,
    );
  }, [data, networkModules]);

  const staleCount = useMemo(() => {
    if (!data) return 0;
    return data.members.reduce((total, member) => {
      const modules = memberMessages.get(member.address);
      return (
        total +
        networkModules.filter(({ key }) => {
          if (voteStateFor(member.lastSlots[key], data.frames[key]) === "not-started") return false;
          const message = modules?.get(key);
          return !message || message.ageSeconds > STALE_SECONDS;
        }).length
      );
    }, 0);
  }, [data, memberMessages, networkModules]);
  const trackedBalances =
    data?.members.flatMap((member) => [
      member.balanceEth,
      ...(member.telemetryBalanceEth === undefined ||
      (network === "hoodi" &&
        member.telemetryAddress === (member.delegateAddress ?? member.address))
        ? []
        : [member.telemetryBalanceEth]),
    ]) ?? [];
  const lowestBalance = trackedBalances.length
    ? Math.min(...trackedBalances)
    : 0;
  // On Mainnet the telemetry key is separate from the oracle wallet, so a
  // member without a known telemetry key counts as a wallet to check.
  const missingTelemetryBalanceCount =
    network === "mainnet" && !data?.telemetryLoading
      ? (data?.members.filter(
          (member) => member.telemetryBalanceEth === undefined,
        ).length ?? 0)
      : 0;
  const lowBalanceCount =
    trackedBalances.filter((balance) => balance < LOW_BALANCE_ETH).length +
    missingTelemetryBalanceCount;

  // Messages that pass the search and the module, event and holder filters,
  // with the number of found messages per option for the filter menus.
  const telemetryFilter = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = (data?.messages ?? []).filter(
      (message) =>
        !needle ||
        message.sender.includes(needle) ||
        (LABELS[message.memberAddress ?? message.holderAddress ?? message.sender] ?? "")
          .toLowerCase()
          .includes(needle) ||
        message.transactionHash.toLowerCase().includes(needle) ||
        String(message.blockNumber).includes(needle),
    );
    return filterWithCounts(found, {
      module: { selected: moduleFilter, valueOf: (message) => message.module },
      event: { selected: eventFilter, valueOf: (message) => message.event },
      holder: {
        selected: telemetryHolderFilter,
        valueOf: (message) => message.holderAddress,
      },
    });
  }, [data, eventFilter, moduleFilter, query, telemetryHolderFilter]);
  const filteredReports = telemetryFilter.items;

  const visibleReport = selectedReport ?? filteredReports[0] ?? null;
  const oraclePayload = oraclePayloads[oraclePayloadKey];
  const oracleFilter = useMemo(
    () =>
      filterWithCounts(oraclePayload?.reports ?? [], {
        module: {
          selected: oracleModuleFilter,
          valueOf: (report) => report.module,
        },
        phase: {
          selected: oraclePhaseFilter,
          valueOf: (report) => report.phase,
        },
        holder: {
          selected: oracleHolderFilter,
          valueOf: (report) =>
            holderContractFor(network, report.sender, holderByMember),
        },
      }),
    [
      holderByMember,
      network,
      oracleHolderFilter,
      oracleModuleFilter,
      oraclePayload,
      oraclePhaseFilter,
    ],
  );
  const filteredOracleReports = oracleFilter.items;
  const visibleOracleReport =
    selectedOracleReport ?? filteredOracleReports[0] ?? null;
  // The frame of the open report: its transactions are highlighted in the
  // ledger and listed in the inspector, also the ones hidden by the filters.
  const visibleFrameKey = visibleOracleReport
    ? frameKey(visibleOracleReport)
    : null;
  const visibleFrame = useMemo(
    () =>
      visibleOracleReport
        ? frameReports(oraclePayload?.reports ?? [], visibleOracleReport)
        : null,
    [oraclePayload, visibleOracleReport],
  );
  // A report opened from the frame summary can be outside the visible part
  // of the ledger: scroll the ledger, not the page, to its row.
  const oracleLedger = useRef<HTMLDivElement>(null);
  const visibleOracleKey = visibleOracleReport
    ? reportKey(visibleOracleReport)
    : null;
  useEffect(() => {
    const ledger = oracleLedger.current;
    const row = ledger?.querySelector("button.active");
    if (!ledger || !row) return;
    const view = ledger.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    if (bounds.top < view.top) ledger.scrollTop -= view.top - bounds.top;
    else if (bounds.bottom > view.bottom) {
      ledger.scrollTop += bounds.bottom - view.bottom;
    }
  }, [visibleOracleKey]);

  const explorer = NETWORKS[network].explorer;
  const moduleOptions: FilterOption<ModuleKey>[] = networkModules.map(
    ({ key, label, full }) => ({ value: key, label, title: full }),
  );
  const phaseOptions: FilterOption<ReportPhase>[] = REPORT_PHASES.map(
    ({ key, label, full }) => ({ value: key, label, title: full }),
  );
  const eventOptions: FilterOption<TelemetryEvent>[] = TELEMETRY_EVENT_KINDS.map(
    ({ key, label, full }) => ({ value: key, label, title: full }),
  );
  const holderOptions: FilterOption<string>[] = (data?.holders ?? []).map(
    (holder) => ({
      value: holder.contract,
      label: holder.label,
      title: holder.contract,
    }),
  );

  return (
    <main className="app-shell">
      <SiteHeader network={network} title="Lido Oracle Watch" subtitle="Onchain operations console" icon={<Radio size={18}/>} actions={<>
          <span className="updated">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Live RPC"}
          </span>
          <button
            className="refresh-button"
            type="button"
            onClick={() => {
              void load();
              if (view === "oracle") {
                setOraclePayloads((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(
                      ([key]) => !key.startsWith(`${network}:`),
                    ),
                  ),
                );
              }
            }}
            disabled={loading || oracleLoading}
          >
            <RefreshCw
              className={loading || oracleLoading ? "spin" : ""}
              size={16}
            />
            Refresh
          </button>
      </>} navigation={<nav className="view-tabs" aria-label="Monitor views">
          <button
            type="button"
            className={view === "overview" ? "active" : ""}
            onClick={() => navigate("overview")}
          >
            <Activity size={16} /> Overview
          </button>
          <button
            type="button"
            className={view === "telemetry" ? "active" : ""}
            onClick={() => navigate("telemetry")}
          >
            <FileJson size={16} /> Telemetry details
          </button>
          <button
            type="button"
            className={view === "oracle" ? "active" : ""}
            onClick={() => navigate("oracle")}
          >
            <ListTree size={16} /> Oracle reports
          </button>
        </nav>}/>


      <NetworkBar network={network} label="Oracle network" onChange={key => {
        setSelectedReport(null); setSelectedOracleReport(null); navigate(view, key);
      }}/>
      {error && snapshot && <div className="report-warning" role="alert">Refresh failed: {error} Showing the last successful snapshot.</div>}
      {snapshot?.[network].warnings.map(warning => <div className="report-warning" role="status" key={warning}>{warning}</div>)}

      {loading && (!snapshot || (view==="telemetry"&&!snapshot[network].fullHistoryLoaded)) ? (
        <LoadingState />
      ) : error && (!snapshot || (view==="telemetry"&&!snapshot[network].fullHistoryLoaded)) ? (
        <section className="error-state">
          <AlertTriangle size={22} />
          <div>
            <strong>Could not read the chains</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </section>
      ) : data ? (
        view === "overview" ? (
          <section className="workspace">
            <div className="summary-band">
              <div className="summary-intro">
                <div className="eyebrow">{NETWORKS[network].label} status</div>
                <h1>Oracle participation</h1>
                <p>
                  Committee membership from HashConsensus, cross-checked against
                  the latest DataBus heartbeat for every module.
                </p>
              </div>
              <div className="metric">
                <span>Members</span>
                <strong>{data.members.length}</strong>
                <small>authoritative set</small>
              </div>
              <div
                className={`metric ${lowBalanceCount ? "warning" : "healthy"}`}
              >
                <span>Lowest balance</span>
                <strong>{formatBalance(lowestBalance)}</strong>
                <small>
                  ETH ·{" "}
                  {lowBalanceCount
                    ? `${lowBalanceCount} wallet${
                        lowBalanceCount === 1 ? "" : "s"
                      } below ${LOW_BALANCE_ETH} ETH`
                    : "all wallets funded"}
                </small>
              </div>
              <div className={`metric ${missedReportCount ? "warning" : "healthy"}`}>
                <span>Missed reports</span>
                <strong>{missedReportCount}</strong>
                <small>
                  {missedReportCount
                    ? "no vote in the last frame"
                    : "every seat voted"}
                </small>
              </div>
              <div className={`metric ${staleCount ? "warning" : "healthy"}`}>
                <span>Telemetry breaches</span>
                <strong>{data.telemetryLoading ? "—" : staleCount}</strong>
                <small>{data.telemetryLoading ? "Loading telemetry…" : staleCount ? "silent over 24h" : "all current"}</small>
              </div>
            </div>

            <section className="panel participation-panel" id="members">
              <header className="panel-header">
                <div>
                  <h2>Participation matrix</h2>
                  <p>
                    Current members and each module’s latest DataBus telemetry.
                  </p>
                </div>
                <div className="legend">
                  <span>
                    <i className="legend-good" /> reported, telemetry within 24h
                  </span>
                  <span>
                    <i className="legend-partial" /> reported, telemetry silent
                  </span>
                  <span>
                    <i className="legend-overdue" /> no report in the last frame
                  </span>
                </div>
              </header>
              <div className="table-scroll">
                <div
                  className="matrix"
                  role="table"
                  style={{ "--matrix-modules": networkModules.length } as React.CSSProperties}
                >
                  <div className="matrix-head" role="row">
                    <span role="columnheader">Oracle member</span>
                    {networkModules.map((module) => (
                      <span role="columnheader" key={module.key} title={module.full}>
                        {module.label}
                      </span>
                    ))}
                  </div>
                    {data.members.map((member) => {
                      const holder = holderByMember.get(member.address);
                      const state = holder?.state;
                      // Seat held by the contract itself, or by a legacy EOA
                      // (or delegate key) of the operator that owns a contract.
                      const seat: SeatKind | undefined = !holder
                        ? undefined
                        : holder.contract === member.address
                          ? "contract"
                          : state?.delegateAddress === member.address
                            ? "delegate"
                            : "legacy";
                      // Wallet that signs reports: the delegate key of the
                      // contract holding the seat, otherwise the member EOA.
                      const walletAddress = member.delegateAddress ?? member.address;
                      const versions = holder
                        ? {
                            latest: holderTelemetry.latest.get(holder.contract),
                            startups: holderTelemetry.startups.get(holder.contract),
                          }
                        : undefined;
                      // On Hoodi the telemetry key is often the wallet itself; on
                      // Mainnet the same address holds a separate Hoodi balance.
                      const sameWallet =
                        network === "hoodi" && member.telemetryAddress === walletAddress;
                      return (
                        <div className="matrix-row" role="row" key={member.address}>
                          <div className="member-card" role="cell">
                              <div className="member-details">
                                <strong>
                                  {LABELS[member.address] ?? "Unknown operator"}
                                  {seat && (
                                    <span className={`holder-seat ${seat}`}>
                                      {seat === "contract"
                                        ? "Contract"
                                        : seat === "delegate"
                                          ? "Delegate key"
                                          : "Legacy EOA"}
                                    </span>
                                  )}
                                  {state?.terminated && (
                                    <span className="holder-seat terminated">
                                      Terminated
                                    </span>
                                  )}
                                </strong>
                                <dl className="member-facts">
                                  <div>
                                    <dt>{seat === "contract" ? "Contract" : "Member"}</dt>
                                    <dd>
                                      <AddressLink address={member.address} explorer={explorer} head={6} tail={4} />
                                    </dd>
                                  </div>
                                  {holder && seat !== "contract" && (
                                    <div>
                                      <dt>Contract</dt>
                                      <dd>
                                        <AddressLink address={holder.contract} explorer={explorer} head={6} tail={4} />
                                      </dd>
                                    </div>
                                  )}
                                  {state && (
                                    <div>
                                      <dt>Owner</dt>
                                      <dd>
                                        <AddressLink address={state.ownerAddress} explorer={explorer} head={6} tail={4} />
                                      </dd>
                                    </div>
                                  )}
                                  {state && (
                                    <div>
                                      <dt>Delegate</dt>
                                      <dd>
                                        <AddressLink address={state.delegateAddress} explorer={explorer} head={6} tail={4} />
                                        {seat !== "contract" && (
                                          <span className="muted">not the member yet</span>
                                        )}
                                      </dd>
                                    </div>
                                  )}
                                  {state?.pendingDelegateAddress && (
                                    <div>
                                      <dt>Pending</dt>
                                      <dd>
                                        <AddressLink address={state.pendingDelegateAddress} explorer={explorer} head={6} tail={4} />
                                        <span className="muted">
                                          {state.pendingActiveFrom !== undefined &&
                                          state.pendingActiveFrom > nowSeconds
                                            ? `from ${formatTime(state.pendingActiveFrom)}`
                                            : "settling"}
                                        </span>
                                      </dd>
                                    </div>
                                  )}
                                  {state && (
                                    <div>
                                      <dt>Terminated</dt>
                                      <dd>
                                        <span className={state.terminated ? "status-bad" : "status-ok"}>
                                          {state.terminated === undefined
                                            ? "n/a"
                                            : state.terminated
                                              ? "yes"
                                              : "no"}
                                        </span>
                                        <span className="muted">
                                          · cooldown{" "}
                                          {state.cooldownSeconds !== undefined
                                            ? formatDuration(state.cooldownSeconds)
                                            : "n/a"}
                                        </span>
                                      </dd>
                                    </div>
                                  )}
                                </dl>
                                <div className="wallet-chips">
                                  <BalanceChip
                                    label="Wallet"
                                    address={walletAddress}
                                    balanceEth={member.balanceEth}
                                    explorer={explorer}
                                  />
                                  {!sameWallet && (
                                    <BalanceChip
                                      label="Telemetry"
                                      address={member.telemetryAddress}
                                      balanceEth={member.telemetryBalanceEth}
                                      explorer={DATABUS_EXPLORER}
                                    />
                                  )}
                                </div>
                              </div>
                          </div>
                          {networkModules.map(({ key }) => {
                            const message = memberMessages
                              .get(member.address)
                              ?.get(key);
                            const recent =
                              !!message &&
                              message.ageSeconds <= STALE_SECONDS;
                            const slot = member.lastSlots[key];
                            const frame = data.frames[key];
                            const vote = voteStateFor(slot, frame);
                            const reported = vote === "current" || vote === "previous";
                            // Four states, named in words inside the tile:
                            // reported + telemetry, reported only, telemetry
                            // only, nothing.
                            const tone =
                              data.telemetryLoading ? "pending" : vote === "not-started"
                                ? "pending"
                                : vote === "unknown"
                                ? recent
                                  ? "recent"
                                  : "overdue"
                                : reported
                                  ? recent
                                    ? "recent"
                                    : "partial"
                                  : "overdue";
                            const voteText =
                              vote === "current"
                                ? `Reported · ref slot ${slot?.toLocaleString()}`
                                : vote === "previous"
                                  ? `Reported · previous frame ${slot?.toLocaleString()}`
                                  : vote === "missed"
                                    ? slot
                                      ? `Not reported · last ref slot ${slot.toLocaleString()}`
                                      : "Not reported · never voted"
                                    : vote === "not-started"
                                      ? "Not started · initial epoch has not arrived"
                                      : "Not in this committee";
                            const telemetryText = data.telemetryLoading ? "Loading telemetry…" : message
                              ? recent
                                ? `Telemetry ${relativeTime(message.ageSeconds)} · #${message.blockNumber.toLocaleString()}`
                                : `Telemetry silent · last ${relativeTime(message.ageSeconds)}`
                              : "No telemetry in 7d";
                            const version =
                              versions?.latest?.get(key)?.version ??
                              versions?.startups?.get(key)?.version;
                            const kapiVersion = versions?.startups?.get(key)?.kapiVersion;
                            return (
                              <div role="cell" key={key}>
                                <div
                                  className={`slot-cell ${tone}`}
                                  title={[
                                    voteText,
                                    frame && !("notStarted" in frame)
                                      ? `current frame ref slot ${frame.refSlot.toLocaleString()}`
                                      : "",
                                    telemetryText,
                                    message ? formatTime(message.timestamp) : "",
                                  ]
                                    .filter(Boolean)
                                    .join("\n")}
                                >
                                  <span className="slot-ok">
                                    {vote === "not-started" ? (
                                      <Clock3 size={15} />
                                    ) : reported || (vote === "unknown" && recent) ? (
                                      <CheckCircle2 size={15} />
                                    ) : (
                                      <AlertTriangle size={15} />
                                    )}
                                    {vote === "not-started"
                                      ? "Not started"
                                      : vote === "unknown"
                                      ? recent
                                        ? "Telemetry ok"
                                        : "Telemetry silent"
                                      : reported
                                        ? "Reported"
                                        : "Not reported"}
                                  </span>
                                  <span className="slot-relative">
                                    {vote === "not-started"
                                      ? "Initial epoch has not arrived"
                                      : vote === "unknown"
                                      ? telemetryText
                                      : voteText.replace(/^(Reported|Not reported) · /, "")}
                                  </span>
                                  {vote !== "unknown" && (
                                    <span className={`slot-telemetry ${recent ? "" : "silent"}`}>
                                      {telemetryText}
                                    </span>
                                  )}
                                  {slot !== undefined && !data.telemetryLoading && <TelemetryReadiness module={key} frame={frame} message={readinessMessages.get(member.address)?.get(key) ?? (holder ? readinessMessages.get(holder.contract)?.get(key) : undefined)} />}
                                  {(version || kapiVersion) && (
                                    <span className="slot-versions">
                                      {version ?? "—"} · KAPI {kapiVersion ?? "—"}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                </div>
              </div>
            </section>

          </section>
        ) : view === "telemetry" ? (
          <section className="workspace reports-workspace">
            <div className="reports-heading">
              <div>
                <div className="eyebrow">
                  {NETWORKS[network].label} · block by block
                </div>
                <h1>Telemetry details</h1>
                <p>
                  Inspect every captured telemetry payload of the tracked modules in
                  descending block order.
                </p>
              </div>
              <div className="reports-count">
                <strong>{filteredReports.length}</strong>
                <span>matching messages</span>
              </div>
            </div>

            <div className="filter-bar" role="group" aria-label="Filters">
              <FilterMenu
                label="Module"
                options={moduleOptions}
                selected={moduleFilter}
                counts={telemetryFilter.counts.module}
                onChange={(modules) => {
                  setSelectedReport(null);
                  navigate("telemetry", network, { modules });
                }}
              />
              <FilterMenu
                label="Event"
                options={eventOptions}
                selected={eventFilter}
                counts={telemetryFilter.counts.event}
                onChange={(events) => {
                  setSelectedReport(null);
                  navigate("telemetry", network, { events });
                }}
              />
              <FilterMenu
                label="Holder"
                options={holderOptions}
                selected={telemetryHolderFilter}
                counts={telemetryFilter.counts.holder}
                onChange={(telemetryHolders) => {
                  setSelectedReport(null);
                  navigate("telemetry", network, { telemetryHolders });
                }}
              />
              <label className="search-field">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    setQuery(nextQuery);
                    setSelectedReport(null);
                    router.replace(
                      routeFor("telemetry", network, { query: nextQuery }),
                      { scroll: false },
                    );
                  }}
                  placeholder="Search member, block, or tx"
                  aria-label="Search reports"
                />
              </label>
              <button
                type="button"
                className="filter-reset"
                disabled={
                  !moduleFilter.length &&
                  !eventFilter.length &&
                  !telemetryHolderFilter.length &&
                  !query
                }
                onClick={() => {
                  setQuery("");
                  setSelectedReport(null);
                  navigate("telemetry", network, {
                    modules: [],
                    events: [],
                    telemetryHolders: [],
                    query: "",
                  });
                }}
              >
                Reset
              </button>
            </div>

            <div className="reports-layout">
              <section className="report-ledger" aria-label="Report ledger">
                <header className="ledger-header">
                  <span>Block / module</span>
                  <span>Sender</span>
                  <span>Age</span>
                </header>
                <div className="ledger-rows">
                  {filteredReports.length ? (
                    filteredReports.slice(0, 500).map((message) => (
                      <button
                        type="button"
                        key={`${message.transactionHash}-${message.module}`}
                        className={
                          visibleReport?.transactionHash === message.transactionHash
                            ? "active"
                            : ""
                        }
                        onClick={() => setSelectedReport(message)}
                      >
                        <span className="ledger-block">
                          <strong>#{message.blockNumber.toLocaleString()}</strong>
                          <ModulePill module={message.module} />
                          <span className="ledger-event">
                            {eventLabel(message.event)}
                          </span>
                        </span>
                        <span className="ledger-sender">
                          <strong>
                            {LABELS[
                              message.memberAddress ??
                                message.holderAddress ??
                                message.sender
                            ] ?? "Unknown operator"}
                          </strong>
                          <small>{shorten(message.sender, 5, 4)}</small>
                        </span>
                        <span
                          className={
                            message.ageSeconds > STALE_SECONDS
                              ? "ledger-age stale"
                              : "ledger-age"
                          }
                        >
                          {relativeTime(message.ageSeconds)}
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                  ) : (
                    <div className="no-results">
                      <Search size={20} />
                      <strong>No reports match this filter</strong>
                      <span>Try another filter or search term.</span>
                    </div>
                  )}
                  {filteredReports.length > 500 && (
                    <div className="ledger-limit">
                      Showing the latest 500 of{" "}
                      {filteredReports.length.toLocaleString()} matching reports
                    </div>
                  )}
                </div>
              </section>

              <aside className="report-inspector">
                {visibleReport ? (
                  <>
                    <header className="inspector-header">
                      <div>
                        <div className="eyebrow">Selected report</div>
                        <h2>
                          Block {visibleReport.blockNumber.toLocaleString()}
                        </h2>
                      </div>
                      <div className="inspector-actions">
                        <CopyButton
                          value={visibleReport.pretty}
                          onCopied={copied}
                          label="Copy formatted report"
                        />
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => setOpenMessage(visibleReport)}
                          aria-label="Expand report"
                          title="Expand report"
                        >
                          <Maximize2 size={15} />
                        </button>
                      </div>
                    </header>
                    <div className="report-metadata">
                      <div>
                        <span>Module</span>
                        <ModulePill module={visibleReport.module} />
                        <span className="ledger-event">
                          {eventLabel(visibleReport.event)}
                        </span>
                      </div>
                      <div>
                        <span>Sender</span>
                        <strong>
                          {LABELS[
                            visibleReport.memberAddress ?? visibleReport.sender
                          ] ?? "Unknown operator"}
                        </strong>
                      </div>
                      <div>
                        <span>Observed</span>
                        <strong>{formatTime(visibleReport.timestamp)}</strong>
                      </div>
                      <div>
                        <span>Transaction</span>
                        <a
                          href={`${DATABUS_EXPLORER}/tx/${visibleReport.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shorten(visibleReport.transactionHash, 8, 6)}
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </div>
                    {visibleReport.event === "diagnostic" && <TelemetryReadiness module={visibleReport.module} message={visibleReport} frame={visibleReport.module === "unknown" ? undefined : data?.frames[visibleReport.module]} />}
                    <pre className="json-view compact">
                      {visibleReport.pretty}
                    </pre>
                  </>
                ) : (
                  <div className="inspector-empty">
                    <ServerCog size={24} />
                    <strong>Select a report</strong>
                    <span>Its decoded payload will appear here.</span>
                  </div>
                )}
              </aside>
            </div>
          </section>
        ) : (
          <section className="workspace reports-workspace oracle-workspace">
            <div className="reports-heading">
              <div>
                <div className="eyebrow">
                  {NETWORKS[network].label} · report transactions
                </div>
                <h1>Onchain oracle reports</h1>
                <p>
                  All report phases: hash votes in HashConsensus, decoded
                  submitReportData calls and Accounting Oracle extra data, sent
                  directly or through Execution Delegation Framework contracts.
                </p>
              </div>
              <div className="reports-count">
                <strong>{filteredOracleReports.length}</strong>
                <span>decoded transactions</span>
              </div>
            </div>

            {oraclePayload && (
              <div className="receiver-strip" aria-label="Oracle receivers">
                {availableModules(oraclePayload.contracts).map(({ key, full }) => (
                  <a
                    key={key}
                    href={`${explorer}/address/${oraclePayload.contracts[key]}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ModulePill module={key} />
                    <span>
                      <strong>{full}</strong>
                      <small>
                        {shorten(oraclePayload.contracts[key] as string, 7, 5)}
                      </small>
                    </span>
                    <ExternalLink size={12} />
                  </a>
                ))}
              </div>
            )}

            <div className="filter-bar" role="group" aria-label="Filters">
              <FilterMenu
                label="Module"
                options={moduleOptions}
                selected={oracleModuleFilter}
                counts={oracleFilter.counts.module}
                onChange={(oracleModules) => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, { oracleModules });
                }}
              />
              <FilterMenu
                label="Phase"
                options={phaseOptions}
                selected={oraclePhaseFilter}
                counts={oracleFilter.counts.phase}
                onChange={(phases) => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, { phases });
                }}
              />
              <FilterMenu
                label="Holder"
                options={holderOptions}
                selected={oracleHolderFilter}
                counts={oracleFilter.counts.holder}
                onChange={(holders) => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, { holders });
                }}
              />
              <span className="filter-divider" />
              <Dropdown label="Hash votes" value={`${hashVoteFrames} frames`}>
                {(close) =>
                  HASH_VOTE_FRAMES.map((frames) => (
                    <button
                      type="button"
                      key={frames}
                      role="menuitemradio"
                      aria-checked={hashVoteFrames === frames}
                      title={`Load hash votes of the latest ${frames} frames per module, within about 35 days of history`}
                      onClick={() => {
                        close();
                        setSelectedOracleReport(null);
                        navigate("oracle", network, { frames });
                      }}
                    >
                      <span className="filter-menu-box round">
                        {hashVoteFrames === frames && <i />}
                      </span>
                      Latest {frames} frames
                    </button>
                  ))
                }
              </Dropdown>
              <button
                type="button"
                className="filter-reset"
                disabled={
                  !oracleModuleFilter.length &&
                  !oraclePhaseFilter.length &&
                  !oracleHolderFilter.length
                }
                onClick={() => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, {
                    oracleModules: [],
                    phases: [],
                    holders: [],
                  });
                }}
              >
                Reset
              </button>
            </div>

            {oraclePayload?.warnings?.map((warning) => (
              <div className="report-warning" role="status" key={warning}>
                <AlertTriangle size={14} />
                {warning}
              </div>
            ))}

            {oracleLoading && !oraclePayload ? (
              <div className="loading-state report-loading" role="status">
                <LoaderCircle className="spin" size={22} />
                <div>
                  <strong>Decoding receiver transactions</strong>
                  <span>
                    Unwrapping delegated calldata and resolving block timestamps
                  </span>
                </div>
              </div>
            ) : oracleError && !oraclePayload ? (
              <section className="error-state">
                <AlertTriangle size={22} />
                <div>
                  <strong>Could not read oracle reports</strong>
                  <span>{oracleError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setOracleError(null);
                    setOraclePayloads((current) => ({ ...current }));
                  }}
                >
                  Try again
                </button>
              </section>
            ) : (
              <div className="reports-layout oracle-reports-layout">
                <section className="report-ledger" aria-label="Oracle report ledger">
                  <header className="ledger-header">
                    <span>Block / module / phase</span>
                    <span>Submitter</span>
                    <span>Age</span>
                  </header>
                  <div className="ledger-rows" ref={oracleLedger}>
                    {filteredOracleReports.length ? (
                      filteredOracleReports.map((report) => {
                        const ageSeconds = Math.max(
                          0,
                          Math.floor((updatedAt?.getTime() ?? 0) / 1000) -
                            report.timestamp,
                        );
                        return (
                          <button
                            type="button"
                            key={reportKey(report)}
                            className={
                              visibleOracleReport &&
                              reportKey(visibleOracleReport) === reportKey(report)
                                ? "active"
                                : frameKey(report) === visibleFrameKey
                                  ? "related"
                                  : "unrelated"
                            }
                            onClick={() => setSelectedOracleReport(report)}
                          >
                            <span className="ledger-block">
                              <strong>#{report.blockNumber.toLocaleString()}</strong>
                              <span className="ledger-pills">
                                <ModulePill module={report.module} />
                                <PhasePill phase={report.phase} />
                              </span>
                            </span>
                            <span className="ledger-sender">
                              <strong>
                                {LABELS[report.sender] ??
                                  (report.phase === "hash"
                                    ? "Committee member"
                                    : "Authorized submitter")}
                              </strong>
                              <small>slot {report.refSlot.toLocaleString()}</small>
                            </span>
                            <span className="ledger-age">
                              {relativeTime(ageSeconds)}
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        );
                      })
                    ) : (
                      <div className="no-results">
                        <ListTree size={20} />
                        <strong>No decoded reports in this filter</strong>
                        <span>
                          There may be no recent report activity for this
                          module, phase and holder.
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                <aside className="report-inspector oracle-inspector">
                  {visibleOracleReport && visibleFrame ? (
                    <OracleReportInspector
                      report={visibleOracleReport}
                      frame={visibleFrame}
                      committeeSize={
                        data.members.filter(
                          (member) =>
                            member.lastSlots[visibleOracleReport.module] !==
                            undefined,
                        ).length || undefined
                      }
                      hashVoteFrames={hashVoteFrames}
                      explorer={explorer}
                      onCopied={copied}
                      onSelect={setSelectedOracleReport}
                    />
                  ) : (
                    <div className="inspector-empty">
                      <ServerCog size={24} />
                      <strong>Select an oracle report</strong>
                      <span>Its decoded fields will appear here.</span>
                    </div>
                  )}
                </aside>
              </div>
            )}
          </section>
        )
      ) : null}

      {openMessage && (
        <JsonModal
          message={openMessage}
          onClose={() => setOpenMessage(null)}
          onCopied={copied}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={15} /> Copied to clipboard
        </div>
      )}
      <footer className="app-footer">
        <span>
          <Clock3 size={13} /> Auto-refreshes every 10 minutes
        </span>
        <span>
          Membership: HashConsensus · Telemetry: DataBus · Reports:
          HashConsensus events and receiver calldata
        </span>
      </footer>
    </main>
  );
}
