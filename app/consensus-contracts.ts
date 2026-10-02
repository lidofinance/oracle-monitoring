import type { OracleModule } from "./oracle-modules";

// HashConsensus contracts per module. The Accounting Oracle consensus is
// required because its chain config is used for slot timing; other modules
// are tracked only on the networks where they are deployed.
export const CONSENSUS_CONTRACTS: Record<
  "mainnet" | "hoodi",
  Partial<Record<OracleModule, string>> & { ao: string }
> = {
  mainnet: {
    ao: "0xD624B08C83bAECF0807Dd2c6880C3154a5F0B288",
    vebo: "0x7FaDB6358950c5fAA66Cb5EB8eE5147De3df355a",
    csm: "0x71093efF8D8599b5fA340D665Ad60fA7C80688e4",
    cm: "0x902D64c93F6595339aA46105627a085591051aFb",
  },
  hoodi: {
    ao: "0x32EC59a78abaca3f91527aeB2008925D5AaC1eFC",
    vebo: "0x30308CD8844fb2DB3ec4D056F1d475a802DCA07c",
    csm: "0x54f74a10e4397dDeF85C4854d9dfcA129D72C637",
    csm_0x02: "0x41142D077860906B0A7Debb270f1B8e7d1c8BF34",
    cm: "0x920883908A78c1554f682006a8aB32E62Be09F33",
  },
};
