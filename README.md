# <img src="docs/logo.svg" height="70px" align="center" alt="Lido Logo"/> Lido Oracle Watch

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

One-page onchain operations console for the Lido Oracle committees on Ethereum
Mainnet and Hoodi. It reads public RPC endpoints directly and needs no API keys
or database.

## What it shows

- Overview - current HashConsensus members of every oracle module, their EDF
  delegate keys, wallet balances and the latest DataBus heartbeat per module.
- Overview - current HashConsensus members of every oracle module with the
  latest DataBus heartbeat per module, oracle and Keys API versions, wallet
  balances and the EDF DelegationContract behind each seat (delegate key,
  owner, pending delegate, cooldown, status).
- Telemetry details - the raw DataBus messages sent by oracle operators, with
  multi-select filters by module, event kind (report, startup, diagnostic)
  and holder, and a search by operator, block or transaction.
- Oracle reports - all three report phases: member votes for the report hash
  in HashConsensus, decoded `submitReportData` calls and Accounting Oracle
  extra data, sent either directly or through Execution Delegation Framework
  (LIP-37) DelegationContracts. Multi-select filters by module, phase and
  holder show the number of reports behind every option; hash votes are
  loaded for the latest 10, 20 or 40 frames per module, within the 35-day
  history window of the report API. The open report highlights the other
  transactions of its frame and lists them by phase.

Tracked modules: Accounting Oracle (AO), Validator Exit Bus Oracle (VEBO),
CSM fee oracle (CSM), CSM 0x02 fee oracle (CSM 0x02, Hoodi only for now) and
Curated Module fee oracle (CM).

## Depositor dashboard

`/depositor/` monitors Lido’s public onchain deposit and top-up activity on
Mainnet and Hoodi. It shows depositable ETH, buffered and total pooled ETH,
current gas wallet balances, EDF delegates/owners, pause gates, withdrawal
queue demand and claimable ETH, historical buffer/demand samples and a searchable transaction ledger with Etherscan links.

The API at `/api/depositor?network=mainnet` (or `hoodi`) resolves protocol
contracts from the canonical Lido Locator and discovers every current
`TOP_UP_ROLE` holder from the gateway. It reads each EDF delegate live, so
key rotations do not require editing addresses. All balances and gates use
one block two blocks behind the head. Snapshots are cached for one minute;
activity and historical samples are cached for five minutes.

Activity covers approximately seven days (50,400 blocks), with at most 120
latest operations. ETH moved comes from Lido’s `Unbuffered` events rather
than the outer transaction value. Both direct DSM calls and top-ups through
EDF are discovered from successful contract events. Failed transactions
emit no events and must be checked in the linked full wallet history.
Missing RPC ranges produce explicit warnings. Buffer charts read historical
contract state once per UTC day over seven calendar days: completed days use
the last block before midnight and today uses the latest confirmed block.
Missing daily readings remain gaps; data is not accumulated from browser visits. Withdrawal demand
is the queue’s unfinalized stETH, displayed in stETH alongside buffer ETH.
Daily withdrawal fulfillment uses `WithdrawalsFinalized`: the inclusive request
ID range counts requests, and `amountOfETHLocked` records ETH made claimable.
Finalization is distinct from an owner claiming ETH. Daily chart summaries use
the same seven UTC calendar days as its bars. Chart ETH/stETH values, including
hover details, are rounded to the nearest whole unit; source data and chart
geometry retain their original precision.

The daily chart also shows nominal VEBO exit demand as a separate bar: each
published `ValidatorExitRequest` counts as 32 ETH, matching Oracle Watch’s
nominal metric. This is explicitly labeled and is not a historical validator
balance or completed withdrawal measurement; 0x02 validator balances can be
larger. Requests are grouped by the event’s publication timestamp, including
requests repeated on different days. The VEBO address is resolved through the
Locator; failed log ranges are flagged as incomplete rather than shown as a
confirmed zero.

This dashboard does not access Lido’s bot hosts. Recent transactions prove
completed operations; inactivity does not establish that a process is down.
Deposits require available ETH, allocation, keys and guardian approval;
top-ups also require eligible validators. Uses the same runtime RPC settings
as the report API, without an Etherscan key or database.

## Quick start with Docker

```bash
# Optional: copy and edit the settings (RPC endpoints, Etherscan key, port)
cp .env.example .env

# Build the image and start the console on http://localhost:3000
docker compose up -d --build

# Use another port
PORT=8080 docker compose up -d --build

# Follow the logs / stop
docker compose logs -f oracle-watch
docker compose down
```

Without Compose:

```bash
docker build -t lidofinance/oracle-monitoring:local .
docker run --rm -p 3000:3000 lidofinance/oracle-monitoring:local
```

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev      # development server with hot reload
npm run build    # production build into dist/
npm run start    # serve the production build (PORT=3000 by default)
```

## Tests and checks

```bash
npm run test:unit   # unit tests for filters, module mapping and report decoding
npm test            # unit tests + production build + server-rendered smoke test
npm run lint
npm run typecheck
```

The same checks and a Docker build run in GitHub Actions on every push and
pull request.

## Configuration

Everything works without configuration. The optional variables below can be
set in `.env` (see `.env.example`) or passed to Docker Compose.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MAINNET_RPC_URLS` | browser, build time | Comma-separated Mainnet RPC URLs for membership, balances and DataBus reads |
| `NEXT_PUBLIC_HOODI_RPC_URLS` | browser, build time | Same for Hoodi (DataBus lives on Hoodi, so this also serves Mainnet telemetry) |
| `MAINNET_RPC_URLS` | report API, runtime | Mainnet RPC URLs for `eth_getLogs` discovery of report transactions |
| `HOODI_RPC_URLS` | report API, runtime | Same for Hoodi |
| `ETHERSCAN_API_KEY` | report API, runtime | Optional Etherscan API v2 key; adds the receivers' direct and internal transactions to the discovery |
| `PORT` | server | HTTP port, `3000` by default |

The report API needs RPC endpoints that serve `eth_getLogs` over 10k-block
ranges for about 35 days of history in batches of five calls. The defaults in
`app/rpc-config.ts` were checked against that requirement.

Contract addresses and operator labels live in the code:

- `app/oracle-modules.ts` - the list of oracle modules and the telemetry
  module mapping.
- `app/consensus-contracts.ts` - HashConsensus addresses.
- `app/oracle-monitor.tsx` - DataBus address and operator labels (member EOAs
  and EDF DelegationContracts).
- `app/api/oracle-reports/route.ts` - report receiver addresses.

To add a module on a network, add its HashConsensus address to
`app/consensus-contracts.ts` and its receiver address to
`app/api/oracle-reports/route.ts`. Modules missing on a network are not shown
there.

## Project layout

```
app/                 Next.js app: pages, the console component, report decoding
app/api/             Route handler that discovers and decodes oracle reports
app/rpc-config.ts    RPC endpoint defaults and environment overrides
tests/               Node test runner suites
worker/              Cloudflare Workers entry (serves the built app)
.github/             CI workflow, Dependabot and code owners
Dockerfile           Production image (Node 22)
docker-compose.yml   Local run with Docker Compose
```

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

Distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE).

## Council dashboard

`/council` has Mainnet and Hoodi tabs, with shareable `?network=mainnet` and
`?network=hoodi` URLs. Mainnet is the default. Each tab monitors its own DSM Council. It discovers guardians
through Lido Locator and resolves each active EDF delegate, owner and pending
key. The balance cards show each delegate's native ETH, xDAI and POL balances
on Ethereum, Gnosis and Polygon respectively. Hoodi shows testnet ETH and
Chiado xDAI funding, with the Hoodi DSM and the documented Chiado DataBus.
Balances are pinned to confirmed chain heads.
The page links to the contracts and network-specific wallet histories.

`/api/council` serves a one-minute cached membership/balance snapshot.
Both API sections accept `network=mainnet|hoodi`; caches and incremental
checkpoints are isolated by network. Unsupported networks return HTTP 400.
`/api/council?section=activity` serves five-minute cached activity over seven
UTC calendar days. DataBus records support legacy compact-signature messages and current EDF
Deposit V2, Pause V4 and Unvet V2 messages, plus Ping V1, inside DataBus's
anonymous bytes envelope. Event ranges are streamed and counted without
retaining every high-volume deposit payload; the ledger keeps a bounded
sample per message kind, with separate room for DSM calls. Complete DataBus
checkpoints are reused for incremental scans during the same UTC window; a
new day or a delegate rotation triggers a fresh scan. Known
rotation keys and pre-EDF guardian keys are included and marked as other keys; current-key
recency never falls back to a former-key heartbeat. Operator labels are
sourced from the linked EDF governance migration, not used to determine
membership. Messages are observed broadcasts, not verified signatures.
RabbitMQ messages and daemon process health are outside this public view.

DSM pause/deposit events are combined with Blockscout's direct and internal
transaction index. Each candidate is checked against the selected execution network's RPC calldata
and receipts. EDF execute calls are decoded only when their target is the
current DSM. Successful unvet calls show operator IDs and target vetted
counts; those counts are not a measurement of how many keys were removed.
Reverted transactions are retained separately from successful-call totals.
A successful pause call can be a no-op when the DSM is already paused.
Unavailable providers, incomplete indexing and truncated coverage produce
warnings and lower-bound totals. The ledger retains up to 500 broadcasts and 100 DSM calls;
charts, totals and per-guardian counts use the full loaded window.

Optional `GNOSIS_RPC_URLS` and `POLYGON_RPC_URLS` runtime variables accept
comma-separated public or private RPC URLs. Ethereum uses `MAINNET_RPC_URLS`, Hoodi uses `HOODI_RPC_URLS`, and
Chiado accepts `CHIADO_RPC_URLS`.
No API keys are required by the default endpoints.

The `/council` page runs in the root-path monitor runtime (port 3012). Include
`deployment/council-routes.nginx.conf` as
`/etc/nginx/snippets/council-routes.conf` in the website's TLS server block;
it reuses the existing depositor proxy snippet and `/assets/` route.

### VEBO exit simulator

`/vebo-simulator?network=mainnet|hoodi` provides a local scenario engine with
editable withdrawal funding, report count and ETH limits, module exit-share
thresholds, node-operator weights and forced/soft target counts. Select a chart
bar to inspect a report, then a queue row to compare the winning operator to
the runner-up at that exact selection step. The first differing predicate is
highlighted. Selection is recalculated after each exit, including connected
MetaRegistry stake changes. Forced continuation compares only forced excess
and validator index. The report's encoded ordering is distinct from selection
ordering. The inspected Oracle's hardcoded request cap is 500; users can
explicitly explore a hypothetical higher cap.

The simulator uses individual predictable principal and 32/2048 ETH effective
balance caps independently. Both request-count and ETH limits stop selection;
a candidate that exceeds the ETH budget is not skipped. Exits selected in earlier
simulated reports cannot be selected again and count as committed principal.
Future demand, rewards, deposit locks and timing of incoming principal are
explicit scenario assumptions. The browser runs simulations in a cancellable
Web Worker. JSON import/export preserves validator pools and operator groups;
imported metadata is never shown as verified live data.

`GET /api/vebo-simulator?network=mainnet&state=frame` starts or polls a snapshot
job (202 while collecting, 200 when ready, 503 on incomplete data). It resolves
the current VEBO reference frame and pins contract calls, Keys API mappings,
Beacon balances, pending deposits/consolidations and recent exit requests to
that reference state. It checks chain identity, EL/CL block hash agreement,
each deposited key index, Lido withdrawal credentials and validator counts.
Unregistered pending deposits require a valid Ethereum BLS POP deposit
signature; registered top-ups and consolidation inflows are capped per validator.
The snapshot includes current weights, target modes and MetaRegistry links.
It never silently fills missing data with zeros.

`state=finalized` explicitly selects a current finalized-state **scenario**, not
the VEBO reference-slot report. Public Beacon APIs may serve current states but
prune historical pending-state endpoints. Exact reference-state loading needs
an archive Beacon API with the corresponding states. Configure comma-separated
`MAINNET_BEACON_URLS` / `HOODI_BEACON_URLS` on the server if needed. Keys API
bases default to `https://keys-api.lido.fi` and
`https://keys-api-hoodi.testnet.fi`; override with `MAINNET_KEYS_API_URL` /
`HOODI_KEYS_API_URL`. EL providers use the existing network RPC variables.
Jobs are shared per network/state mode, cached for 15 minutes after completion,
and failed jobs may retry after one minute. This collector requires the
persistent Node runtime; an edge request lifecycle is not sufficient.

The snapshot provides real selection inputs, **not** a complete reproduction
of the Oracle's future churn/sweep/reward prediction service. Its incoming
principal is an amount, without a predicted arrival epoch. Rewards and deposit
lock start at zero and remain editable. Later reports assume unchanged chain
conditions except the modeled demand growth and previously selected exits.

Include `deployment/vebo-simulator-routes.nginx.conf` in the TLS server blocks
that host the root-path runtime, beside the Council and Depositor includes.
Completed snapshots are also stored in the ignored `.cache/vebo` directory
(`VEBO_CACHE_DIR` overrides it), so restarts can reuse a snapshot within its
15-minute lifetime. Cache writes are atomic and optional; a failed disk write
does not invalidate the collected data. Pending deposit verification yields
between small batches to keep the monitoring server responsive.

Configured archive Beacon nodes take priority for reference-state requests;
public providers remain fallbacks. Finalized scenarios and block/header reads
prefer public providers, so an unavailable archive node does not disable the
explicit finalized-scenario mode. Archive state reads allow up to three minutes
for historical-state reconstruction. Beacon URLs are server-only settings.
