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
  filters by module and a search by operator, block or transaction.
- Oracle reports - decoded `submitReportData` calls received by the oracle
  contracts, either directly or through Execution Delegation Framework
  (LIP-37) DelegationContracts.

Tracked modules: Accounting Oracle (AO), Validator Exit Bus Oracle (VEBO),
CSM fee oracle (CSM), CSM 0x02 fee oracle (CSM 0x02, Hoodi only for now) and
Curated Module fee oracle (CM).

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
npm run test:unit   # unit tests for module mapping and report decoding
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
- `app/oracle-monitor.tsx` - HashConsensus addresses, DataBus address and
  operator labels (member EOAs and EDF DelegationContracts).
- `app/api/oracle-reports/route.ts` - report receiver addresses.

To add a module on a network, add its HashConsensus address to
`app/oracle-monitor.tsx` and its receiver address to
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
