# Security policy

## Reporting a vulnerability

Please do not open public GitHub issues for security problems.

Report vulnerabilities in this project or in the Lido protocol through the
Lido bug bounty program on Immunefi:
https://immunefi.com/bug-bounty/lido/

The program page describes the scope, the rules and the rewards. Reports that
are out of scope for the bounty can be sent to the Lido contributors through
the contacts listed there.

## Scope notes

This console reads public onchain data through public RPC endpoints and stores
no user data. It does not hold keys and cannot send transactions. Problems in
the oracle contracts or in the oracle daemon belong to their own repositories:

- https://github.com/lidofinance/core
- https://github.com/lidofinance/lido-oracle
