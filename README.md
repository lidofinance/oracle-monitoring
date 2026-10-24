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
current gas wallet balances, EDF delegates/owners, pause gates, historical buffer/demand samples and a searchable transaction ledger with Etherscan links.

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

Requires Node.js 26.12.1 or newer (`nvm use` reads `.nvmrc`).

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
Dockerfile           Production image (Node 26)
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

Mainnet is selected by default. Opening the simulator automatically loads the
selected network's current VEBO reference-state snapshot into the controls and
reset baseline. Controls and simulated reports stay in a loading/error state
until real data is ready; they do not expose the fictional example during
collection or fall back to it on failure. The example requires an explicit
button click. Switching networks clears the previous scenario while the next
network loads. Edits made after loading remain local and Reset restores that
loaded baseline.

Live scenarios retain each eligible validator's KAPI public key along with its
Beacon index, cap and predicted balance. The source panel shows operator/key
counts and links to the selected network's KAPI. Selected-validator details
and queue rows display copyable public keys, and JSON export preserves them.
Imported keys must be unique 48-byte hex values; older scenarios without keys
remain supported and do not acquire invented identities. The snapshot cache
requires key-data version 1 so index-only legacy entries are recollected.

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
Jobs are shared per network, selected RPC and state mode. Completed snapshots
are cached for ten minutes after collection; reporting-frame snapshots expire
earlier if their frame ends. Failed jobs expire after ten minutes. Cache metadata
reports the collection and expiry times in the simulator. This collector requires the
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
validity window. Cache writes are atomic and optional; a failed disk write
does not invalidate the collected data. Pending deposit verification yields
between small batches to keep the monitoring server responsive.

Configured archive Beacon nodes take priority for reference-state requests;
public providers remain fallbacks. Finalized scenarios and block/header reads
prefer public providers, so an unavailable archive node does not disable the
explicit finalized-scenario mode. Archive state reads allow up to three minutes
for historical-state reconstruction. Beacon URLs are server-only settings.

## Consolidation Watch

`/consolidation?network=mainnet` (or `hoodi`) monitors the ConsolidationBus,
ConsolidationMigrator and the gateway discovered from the bus. It replays all
publication, execution, removal and Migrator attribution events from the bus's
deployment through a finalized EL block. Each publication is a separate
occurrence: an identical batch hash may be submitted again after execution or
removal. Both queue and execution ledger are ordered oldest first, including
log order within a block. Pending batches are reconciled with `getBatchInfo`.
All contract reads, protocol pause checks and balances use the same block.

CMv1 requested coverage counts unique `(source operator, source key index)`
pairs from Migrator publications, divided by **all ever-deposited CMv1
validators** from StakingRouter operator digests at the finalized block.
Removed requests count toward this explicitly labeled participation metric;
resubmissions do not inflate it. Status-specific counts may overlap after a
resubmission. Publication is not execution, and EL execution does not prove CL
completion. Nominal ETH uses 32 ETH per source and is labeled accordingly.
Operator names come from the network's Keys API; unavailable names fall back to
on-chain operator IDs without replacing counts with zeros.

The quota chart and oldest-batch estimate reproduce the gateway's discrete
`RateLimit` restoration frames. The collector reads the gateway's public
`CONSOLIDATION_LIMIT_POSITION`, unpacks its uint32 fields, and verifies them
against `getConsolidationRequestLimitFullInfo`. The previous timestamp provides
exact frame boundaries. Zero max means unlimited, zero restoration means no
recovery, and a batch larger than the ceiling has no finite estimate. The
estimate waits for both the current (retroactive) bus delay and sufficient
quota, and is suppressed while the gateway, DSM or Lido blocks consolidations.
It assumes no competing consumption or limit changes; proofs, fee/gas ceilings,
validator eligibility and bot polling may delay actual execution.

`GET /api/consolidation?network=mainnet` starts/polls a background snapshot:
202 while collecting, 200 when complete, 503 if reconciliation fails. The
persistent Node runtime is required. Snapshots refresh after two minutes;
failed attempts retry after a minute, preserving an earlier complete snapshot
with an error notice. An atomic, optional history checkpoint in ignored
`.cache/consolidation` (`CONSOLIDATION_CACHE_DIR` overrides it) avoids rescanning
all history on restart. Its block hash must match the canonical finalized
chain before reuse. Network caches are isolated. RPC and Keys API overrides
are the existing network-specific server settings.

`view=transactions&page=0` returns sender/receipt details for pages of 25
successful execution transactions, including permissionless executors other
than the published bot. `view=attempts` independently loads the published
Mainnet bot signer's calls to ConsolidationBus over the last 30 days from
Blockscout, including reverted attempts. Coverage failures and the pagination
cap are visible; a missing indexer never turns failed-attempt counts into zero.
Hoodi has no configured published bot signer, so its event-backed executor
ledger is available while the signer-specific feed is explicitly unavailable.
The Mainnet signer is sourced from the Lido governance funding proposal,
linked on the page. Indexer transaction statuses are shown as reported.

Include `deployment/consolidation-routes.nginx.conf` in each TLS server block
hosting the root-path monitor runtime. `/assets/` remains served by that
runtime, alongside the existing Depositor, Council and VEBO routes.

## Root landing page

`/portal` is the shared monitor runtime's landing page. On `f4ever.pl` and
`www.f4ever.pl`, replace the old exact `/` redirect with
`deployment/portal-root.nginx.conf` (installed as
`/etc/nginx/snippets/portal-root.conf`). The public URL remains `/`; nginx
proxies it internally to `/portal`, forwarding its network query string.
The standalone Oracle runtime's `/oracle` dashboard remains unchanged, and the
repository's existing `/` Oracle entry point still works for standalone
installations. Keep the shared runtime's existing `/assets/` location.

Five cards link to Oracles, Depositor, Council, VEBO Simulator and Consolidation.
The network selector sets Mainnet/Hoodi on every dashboard link; Oracle
Overview, Telemetry and Reports also have direct shortcuts. Each card has a
purpose-specific SVG/CSS scene that animates on hover and keyboard focus.
Reduced-motion preferences disable animation and transitions. The landing
page makes no chain requests or claims about bot health.

Homepage cards include short descriptions and direct section shortcuts. Each
dashboard header has a Home link that preserves the selected network. A shared
hash-navigation helper waits for asynchronously loaded sections before scrolling;
this lets member lists, withdrawal queues and consolidation limits be linked
directly without requiring their RPC snapshots at initial render.

Depositor includes a network-wide Ethereum validator exit queue, collected
independently through `/api/depositor?network=mainnet&view=exit-queue` (or Hoodi).
PublicNode's corresponding Beacon API supplies a verified, current head and two
lists pinned to its state root: active exiting/slashed validators and pending
consolidations. Genesis root and deposit chain ID must match the selected network.
Queued ETH sums effective balances; consolidation sources are counted separately
and excluded from the ordinary exit schedule. The wait describes the existing
queue's last assigned exit epoch, not a forecast for a newly submitted request.
Withdrawal eligibility delay is read from that network's spec; the later sweep
and Lido withdrawal finalization are separate. Client refresh and server caching
are one minute. Failed updates show explicitly stale data for at most 15 minutes,
then unavailable. Configured `MAINNET_BEACON_URLS` / `HOODI_BEACON_URLS` are fallback
providers; private URLs are never sent to the browser.

The Buffer over time chart also includes Lido exiting + awaiting-withdrawal ETH.
`/api/depositor?network=mainnet&view=exit-balances` starts/polls an independent
daily backfill, leaving the rest of the dashboard responsive. Each UTC close
uses one canonical Beacon block and its pinned validator and consolidation
state. Current balances include active exits, exited validators and withdrawable
validators with nonzero balances. Pending consolidation sources are excluded.
KAPI's `/v1/keys/find` establishes membership among used Lido keys; balances are
the actual Gwei balances, including rewards/penalties, not a fixed 32 ETH amount
or effective balance. Sources and networks must agree. Missing historical states
remain gaps. Hover/keyboard inspection shows the validator count and observed
Beacon timestamp. Historic closes persist in `.cache/lido-exit-balances` (override
with `LIDO_EXIT_BALANCE_CACHE_DIR`); today's balance refreshes every five minutes.
Archive endpoints use the configured Beacon URL lists and the previously supplied
Mainnet/Hoodi Lighthouse endpoints when no custom list is configured.

### Exit-to-withdrawal estimate and Lido incoming ETH

The Ethereum validator exit queue includes an independent `/api/depositor?network=mainnet|hoodi&view=exit-forecast` view. It estimates a **32 ETH ordinary full exit processed at the observed Beacon slot**, using the state's `earliest_exit_epoch` and `exit_balance_to_consume`, plus protocol withdrawal eligibility and an observed sweep cycle. It reads only the ~2.7 MB fixed SSZ state prefix, cancels the remainder, checks the network/slot and Electra/Fulu layout, and measures the withdrawal cursor across pinned states covering the last hour. A shorter verified sample remains usable when older states are unavailable; the actual sample duration is shown. Each sample interval is bounded to prevent unobserved full-cycle wraparound. Half a measured sweep cycle is the average unknown validator position; zero to one cycle is an estimated window, not a guarantee. Inclusion delays, slashed exits and stETH finalization are separate. Configured `MAINNET_BEACON_URLS` / `HOODI_BEACON_URLS` need the binary debug-state endpoint; otherwise the supplied Lighthouse archive nodes are used. Unsupported future state layouts or unreliable progress leave the estimate unavailable.

Lido incoming ETH uses seven days of pinned EL state: closing minus opening Withdrawal Vault and EL Rewards Vault balances, plus `WithdrawalsReceived` / `ELRewardsReceived` amounts collected by Lido in that interval. The collector resolves vault addresses through the locator at both boundaries, requires complete event ranges and stable block hashes, and rejects negative accounting. This includes validator principal and swept consensus rewards, plus EL proposal tips/MEV. The estimated wait-period total extrapolates that recent daily rate, rather than predicting future rewards or validator withdrawals. Timing and inflow load independently, use separate network jobs and refresh after five minutes; unavailable measurements never become fabricated zeroes.

### Withdrawal funding balance

The Withdrawals page compares withdrawal demand + deposit lock with current buffer, vault balances, known incoming exit balances, and projected EL/CL rewards over the exit-to-withdrawal horizon above. `/api/depositor?network=mainnet|hoodi&view=liquidity` collects reserves and known Lido exits at the same recent block, pinned to KAPI's EL snapshot and cross-checked against Beacon genesis, canonical header, payload and EL block hash. KAPI's older CL indexing timestamp is not substituted for the current state. Exiting/awaiting validators are matched with KAPI and Lido withdrawal credentials; consolidation sources are excluded. Only those whose withdrawable time plus half the measured sweep cycle is inside the horizon contribute. Capped balances (32/2048 ETH) are counted as exits and known excess is added to CL rewards once.

The current deposits reserve is included on the required side because the full buffer is shown on the funding side. Future deposit consumption uses the Ejector average-case formula: complete accounting frames × min(reserve target, maximum withdrawal request) ÷ 2. Values and assumptions are visible in the widget's methodology. This is a planning model, not an exact replay of a VEBO report: it uses the dashboard's mean sweep estimate and excludes future withdrawal requests, new user deposits and exit messages not yet scheduled by consensus.

CL reward rates pair ETHDistributed and TokenRebased by transaction hash and report timestamp, using (postCLBalance + withdrawalsWithdrawn − preCLBalance) / timeElapsed, floored at zero. Missing/duplicate/mismatched reports leave the rate unavailable and prevent complete model totals. EL projections reuse the independently reconciled vault-arrival rate. Current vault balances are added once, not multiplied by time. CL rewards can compound and remain on Beacon Chain, so accrual projections are explicitly distinguished from guaranteed cash arrivals. Both networks use isolated jobs, short-lived caches, and no fabricated zeroes for unavailable components.

## Withdrawals dashboard

`/withdrawals?network=mainnet|hoodi` is the dedicated home for the Ethereum validator exit queue, exit-to-withdrawal estimates, withdrawal funding balance and Lido's withdrawal queue. It retains Mainnet/Hoodi selection and a Home link. The Buffer over time component is shared with `/depositor`, preserving its daily UTC readings, Lido exit balance line and whole-ETH tooltip behavior on both pages. Depositor Watch retains its deposit/top-up monitoring, gas-wallet link, transaction ledger and daily ETH moved chart; the queue and funding widgets are no longer duplicated there.

Withdrawal Watch adds demand/pending/claimable summary tiles, seven-day finalized ETH and request counts, a daily finalization chart, a transaction-linked finalization history and a short request/finalize/claim lifecycle explanation. Finalized ETH is distinct from claimed ETH; missing finalization ranges are marked incomplete. Shared data continues to use the existing network-isolated `/api/depositor` views and caches. The portal has a dedicated Withdrawals card with network-preserving shortcuts, and its Depositor card links to buffer, bot wallet and transactions. The root nginx snippet routes both `/withdrawals` and `/withdrawals/` to port 3012.

Finalization completeness also reconciles the event request-ID sequence against `getLastFinalizedRequestId` at both boundaries of the loaded block range. Missing days or a truncated successful RPC response trigger an alternate-provider retry; remaining gaps mark totals incomplete rather than silently becoming zero days.

### Shared RPC selection

The network bar on Home and every dashboard has an execution-layer RPC picker. Auto uses the configured endpoint list; an explicit public preset uses only that provider. Choices are saved per network in the browser and shared across sections. Changing a choice reloads the page to restart all collectors together. Beacon and Keys API sources remain independently configured. Server requests carry a validated preset ID, and provider-dependent jobs and caches are separated by network and RPC.

The shared header shows an animated Loading data indicator while any visible collector, background polling job or simulator calculation is pending. Loaded means the current page has no pending work; Partial data means loading has finished with an unavailable source. Hovering the status lists the outstanding or unavailable datasets.

Read-only API requests automatically retry temporary network failures and HTTP 408/425/429/500/502/503/504 responses up to four attempts with backoff and Retry-After support. Cancellation stops outstanding attempts. Exhausted or partial page loads retry after 15/30/60/120 seconds without clearing existing data. Failed background jobs expire sooner; successful forecast components are reused while only failed components recover. Editing a simulator scenario cancels an outstanding snapshot retry.

Dependency tooling uses the TypeScript 7 compiler alongside the official TypeScript 6 API compatibility package required by typescript-eslint. ESLint stays on the latest compatible 9.x release until the Next.js React, accessibility and import plugins support ESLint 10.

The default build targets the self-hosted Node runtime. Use `npm run build:cloudflare` explicitly for the Workers adapter. Compatible security patches for Undici and fflate are overridden until upstream packages update their pins.
