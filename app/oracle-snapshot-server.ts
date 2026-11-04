import { AbiCoder, Contract, formatEther, id, type AbstractProvider, type Log } from "ethers";
import { OracleReadProvider } from "./oracle-provider";
import { readConsensusFrame, type FrameInfo } from "./oracle-consensus";
import { type OracleModule as ModuleKey, ORACLE_MODULES as MODULES, ORACLE_STARTUP_TOPIC, availableModules, moduleFromMessage, parseTelemetrySetup, telemetryEventFromTopic } from "./oracle-modules";
import { serverRpcs } from "./rpc-server";
import { MAINNET_CHAIN_ID, HOODI_CHAIN_ID } from "./rpc-config";
import { compactOracleMessages } from "./oracle-snapshot-cache";
import { NETWORKS, LABELS, HOLDER_CONTRACTS, DATABUS, TELEMETRY_LOOKBACK_BLOCKS, STARTUP_LOOKBACK_BLOCKS, MEMBER_ABI, DELEGATION_ABI, ZERO_ADDRESS, type NetworkConfig, type NetworkKey, type RpcChoice, type Snapshot, type Member, type Holder, type DelegationState, type BusMessage } from "./oracle-snapshot-data";
function shorten(value: string, head = 6, tail = 4) { return `${value.slice(0,head+2)}…${value.slice(-tail)}`; }
function safeJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function chainIdFromMessage(raw: string) {
  try {
    const value = (JSON.parse(raw) as { chain_id?: unknown }).chain_id;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value))
      return Number(value);
  } catch {
    return null;
  }
  return null;
}

function decodeBytes(data: string) {
  try {
    const [bytes] = AbiCoder.defaultAbiCoder().decode(["bytes"], data);
    const clean = bytes.slice(2);
    const chars = clean.match(/.{1,2}/g) ?? [];
    const decoded = new TextDecoder().decode(
      new Uint8Array(chars.map((byte: string) => Number.parseInt(byte, 16))),
    );
    const start = decoded.search(/[\[{]/);
    if (start < 0) return decoded.trim();
    const close = decoded[start] === "{" ? "}" : "]";
    const end = decoded.lastIndexOf(close);
    return decoded.slice(start, end > start ? end + 1 : undefined);
  } catch {
    return data;
  }
}

async function connect(rpcs: readonly string[], chainId: number) {
  const provider = new OracleReadProvider(rpcs, chainId);
  try { await provider.getBlockNumber(); return { provider, url: rpcs[0] }; }
  catch (error) { provider.destroy(); throw error; }
}

// An explicit source is used alone; Auto retains the configured fallback list.
function rpcCandidates(network: NetworkKey, choice: RpcChoice) {
  const chosen = choice[network];
  const defaults = serverRpcs(network);
  return chosen ? [chosen] : defaults;
}



// Read the state of a DelegationContract; null when the address is not one
// (a plain EOA member, or a contract without the EDF interface).
const delegationReads = new WeakMap<AbstractProvider, Map<string, Promise<DelegationState | null>>>();
function readDelegation(provider: AbstractProvider, address: string) {
  let reads = delegationReads.get(provider);
  if (!reads) { reads = new Map(); delegationReads.set(provider, reads); }
  const key = address.toLowerCase();
  let read = reads.get(key);
  if (!read) { read = fetchDelegation(provider, address); reads.set(key, read); }
  return read;
}
async function fetchDelegation(
  provider: AbstractProvider,
  address: string,
): Promise<DelegationState | null> {
  try {
    const delegation = new Contract(address, DELEGATION_ABI, provider);
    // The delegate and owner identify the contract; the other fields are
    // optional so one failing call does not hide the contract.
    const [delegate, owner] = await Promise.all([
      delegation.getDelegate(),
      delegation.owner(),
    ]);
    const [pending, cooldown, terminated] = await Promise.allSettled([
      delegation.getPendingDelegate(),
      delegation.getCooldown(),
      delegation.isTerminated(),
    ]);
    const pendingDelegate =
      pending.status === "fulfilled"
        ? (pending.value[0] as string).toLowerCase()
        : ZERO_ADDRESS;
    return {
      delegateAddress: (delegate as string).toLowerCase(),
      ownerAddress: (owner as string).toLowerCase(),
      pendingDelegateAddress:
        pendingDelegate === ZERO_ADDRESS ? undefined : pendingDelegate,
      pendingActiveFrom:
        pending.status === "fulfilled" && pendingDelegate !== ZERO_ADDRESS
          ? Number(pending.value[1])
          : undefined,
      cooldownSeconds:
        cooldown.status === "fulfilled" ? Number(cooldown.value) : undefined,
      terminated:
        terminated.status === "fulfilled" ? Boolean(terminated.value) : undefined,
    };
  } catch {
    return null;
  }
}

const balanceReads = new WeakMap<AbstractProvider, Map<string, Promise<number>>>();
function readBalance(provider: AbstractProvider, address: string) {
  let reads = balanceReads.get(provider);
  if (!reads) { reads = new Map(); balanceReads.set(provider, reads); }
  const key = address.toLowerCase();
  let read = reads.get(key);
  if (!read) { read = provider.getBalance(address).then(value => Number(formatEther(value))); reads.set(key, read); }
  return read;
}

// Holders are the operators' DelegationContracts. Membership is resolved per
// module from the current HashConsensus members: the contract itself, its
// delegate key, or a legacy EOA labelled with the same operator.
async function fetchHolders(
  provider: AbstractProvider,
  network: NetworkKey,
  members: Member[],
): Promise<Holder[]> {
  const holders = await Promise.all(
    HOLDER_CONTRACTS[network].map(async (contract) => {
      const label = LABELS[contract] ?? shorten(contract, 6, 4);
      const state = (await readDelegation(provider, contract)) ?? undefined;
      const delegateBalanceEth = state
        ? await readBalance(provider, state.delegateAddress).catch(
            () => undefined,
          )
        : undefined;
      const legacyMembers = members.filter(
        (member) =>
          member.address !== contract &&
          member.address !== state?.delegateAddress &&
          LABELS[member.address] === label,
      );
      const seats: Holder["seats"] = {};
      for (const { key } of MODULES) {
        const holds = (address: string | undefined) =>
          address !== undefined &&
          members.some(
            (member) =>
              member.address === address && member.lastSlots[key] !== undefined,
          );
        if (holds(contract)) seats[key] = "contract";
        else if (holds(state?.delegateAddress)) seats[key] = "delegate";
        else if (
          legacyMembers.some((member) => member.lastSlots[key] !== undefined)
        )
          seats[key] = "legacy";
      }
      const senders = [
        contract,
        ...(state ? [state.delegateAddress] : []),
        ...legacyMembers.map((member) => member.address),
      ];
      return { contract, label, state, delegateBalanceEth, seats, senders };
    }),
  );
  return holders.sort((a, b) => a.label.localeCompare(b.label));
}

async function fetchMembers(
  provider: AbstractProvider,
  contracts: NetworkConfig["consensus"],
) {
  const moduleResults = await Promise.all(
    availableModules(contracts).map(async ({ key }) => {
      const contract = new Contract(
        contracts[key] as string,
        MEMBER_ABI,
        provider,
      );
      const [[addresses, slots], currentFrame, [, epochsPerFrame]] =
        await Promise.all([
          contract.getMembers(),
          readConsensusFrame(() => contract.getCurrentFrame()),
          contract.getFrameConfig(),
        ]);
      return {
        key,
        epochsPerFrame: Number(epochsPerFrame),
        values: (addresses as string[]).map((address, index) => ({
          address: address.toLowerCase(),
          slot: Number(slots[index]),
        })),
        frame: currentFrame === null ? null : {
          refSlot: Number(currentFrame[0]),
          epochsPerFrame: Number(epochsPerFrame),
          deadlineSlot: Number(currentFrame[1]),
        },
      };
    }),
  );

  const merged = new Map<string, Member>();
  for (const result of moduleResults) {
    for (const value of result.values) {
      const member = merged.get(value.address) ?? {
        address: value.address,
        balanceEth: 0,
        lastSlots: {},
      };
      member.lastSlots[result.key] = value.slot;
      merged.set(value.address, member);
    }
  }

  const members = [...merged.values()];
  const chainContract = new Contract(contracts.ao, MEMBER_ABI, provider);
  const [[slotsPerEpoch, secondsPerSlot, genesisTime], resolvedMembers] = await Promise.all([
    chainContract.getChainConfig(),
    Promise.all(
      members.map(async (member) => {
        const state = await readDelegation(provider, member.address);
        return state ? { ...member, ...state } : member;
      }),
    ),
  ]);
  const balances = await Promise.all(
    resolvedMembers.map(async (member) => ({
      address: member.address,
      balanceEth: await readBalance(provider, member.delegateAddress ?? member.address),
    })),
  );
  balances.forEach(({ address, balanceEth }) => {
    const member = merged.get(address);
    if (member) member.balanceEth = balanceEth;
  });
  resolvedMembers.forEach((resolved) => {
    const member = merged.get(resolved.address);
    if (!member) return;
    member.delegateAddress = resolved.delegateAddress;
    member.ownerAddress = resolved.ownerAddress;
    member.pendingDelegateAddress = resolved.pendingDelegateAddress;
    member.pendingActiveFrom = resolved.pendingActiveFrom;
    member.cooldownSeconds = resolved.cooldownSeconds;
    member.terminated = resolved.terminated;
  });

  return {
    members: [...merged.values()].sort((a, b) =>
      (LABELS[a.address] ?? a.address).localeCompare(
        LABELS[b.address] ?? b.address,
      ),
    ),
    chainConfig: {
      secondsPerSlot: Number(secondsPerSlot),
      genesisTime: Number(genesisTime),
    },
    frames: Object.fromEntries(
      moduleResults.map(({ key, frame, epochsPerFrame }) => [
        key,
        frame === null ? { notStarted: true, epochsPerFrame } : {
          epochsPerFrame,
          refSlot: frame.refSlot,
          previousRefSlot:
            frame.refSlot - frame.epochsPerFrame * Number(slotsPerEpoch),
          deadlineSlot: frame.deadlineSlot,
        } satisfies FrameInfo,
      ]),
    ) as Partial<Record<ModuleKey, FrameInfo>>,
  };
}

async function fetchLogRanges(
  provider: AbstractProvider,
  filter: { address: string; topics?: (string | string[] | null)[] },
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
) {
  const chunks: Array<{ fromBlock: number; toBlock: number }> = [];
  for (let lo = fromBlock; lo <= toBlock; lo += chunkSize) {
    chunks.push({ fromBlock: lo, toBlock: Math.min(lo + chunkSize - 1, toBlock) });
  }

  const logs: Log[] = [];
  let complete = true;
  for (let index = 0; index < chunks.length; index += 6) {
    const group = chunks.slice(index, index + 6);
    const results = await Promise.allSettled(
      group.map((range) => provider.getLogs({ ...filter, ...range })),
    );
    results.forEach((result) => {
      if (result.status === "fulfilled") logs.push(...result.value);
      else complete = false;
    });
  }
  return { logs, complete };
}

function decodeMessage(log: Log, latest: { number: number; timestamp: number }): BusMessage {
  const raw = decodeBytes(log.data), ageSeconds = Math.max(0, (latest.number-log.blockNumber)*12);
  const setup = parseTelemetrySetup(raw);
  return { blockNumber:log.blockNumber, transactionHash:log.transactionHash, sender:log.topics[1]?`0x${log.topics[1].slice(-40)}`.toLowerCase():"unknown", chainId:chainIdFromMessage(raw), module:moduleFromMessage(raw,log.topics[0]??""), event:telemetryEventFromTopic(log.topics[0]??""), version:setup.version,kapiVersion:setup.kapiVersion,reportedDelegationContract:setup.delegationContract,raw,pretty:safeJson(raw),ageSeconds,timestamp:latest.timestamp-ageSeconds };
}

async function fetchDataBus(provider: AbstractProvider, mode: "overview"|"telemetry", initial: Snapshot) {
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Latest Hoodi block was unavailable");
  const from=Math.max(0,latest.number-TELEMETRY_LOOKBACK_BLOCKS), startupFrom=Math.max(0,latest.number-STARTUP_LOOKBACK_BLOCKS);
  const senders=[...new Set(Object.values(initial).flatMap(data=>data.holders.flatMap(holder=>holder.senders)))];
  const topicSenders=senders.map(sender=>`0x${sender.slice(2).padStart(64,"0")}`);
  if(mode==="telemetry") {
    const [recent,startup]=await Promise.all([
      fetchLogRanges(provider,{address:DATABUS,topics:[null,topicSenders]},from,latest.number,2000),
      startupFrom<from?fetchLogRanges(provider,{address:DATABUS,topics:[ORACLE_STARTUP_TOPIC,topicSenders]},startupFrom,from-1,9000):Promise.resolve({logs:[] as Log[],complete:true}),
    ]);
    return {messages:[...recent.logs,...startup.logs].map(log=>decodeMessage(log,latest)).sort((a,b)=>b.blockNumber-a.blockNumber),warnings:recent.complete&&startup.complete?[]:["Some DataBus log ranges could not be loaded. Telemetry history and recency may be incomplete."]};
  }
  // The overview needs the latest report/diagnostic and startup per member,
  // rather than every restart payload in the full history ledger.
  const recent=await fetchLogRanges(provider,{address:DATABUS,topics:[[id("OracleReport"),id("Diagnostic")],topicSenders]},from,latest.number,9000);
  const messages=recent.logs.map(log=>decodeMessage(log,latest));
  const missing=new Set<string>();
  for(const [network,data] of Object.entries(initial)) for(const member of data.members) for(const moduleKey of Object.keys(member.lastSlots) as ModuleKey[]) {
    const frame=data.frames[moduleKey];
    if(frame&&!("notStarted" in frame)) missing.add(`${network==="mainnet"?MAINNET_CHAIN_ID:HOODI_CHAIN_ID}:${member.delegateAddress??member.address}:${moduleKey}`);
  }
  let complete=recent.complete;
  for(let end=latest.number;end>=startupFrom&&missing.size;end-=9000) {
    const remaining=[...new Set([...missing].map(key=>`0x${key.split(":")[1].slice(2).padStart(64,"0")}`))];
    const batch=await fetchLogRanges(provider,{address:DATABUS,topics:[ORACLE_STARTUP_TOPIC,remaining]},Math.max(startupFrom,end-8999),end,9000);
    complete&&=batch.complete;
    for(const log of batch.logs.sort((a,b)=>b.blockNumber-a.blockNumber)) {
      const message=decodeMessage(log,latest), key=`${message.chainId}:${message.sender}:${message.module}`;
      if(missing.delete(key)) messages.push(message);
    }
  }
  return {messages:messages.sort((a,b)=>b.blockNumber-a.blockNumber),warnings:complete?[]:["Some DataBus log ranges could not be loaded. Telemetry history and recency may be incomplete."]};
}

export async function collectOracleSnapshot(choice: RpcChoice, mode: "overview" | "telemetry", progress: (snapshot: Snapshot) => void): Promise<Snapshot> {
  const [mainnet, hoodi] = await Promise.all([
    connect(rpcCandidates("mainnet", choice), MAINNET_CHAIN_ID),
    connect(rpcCandidates("hoodi", choice), HOODI_CHAIN_ID),
  ]);
  const mainnetProvider = mainnet.provider;
  const hoodiProvider = hoodi.provider;
  try {
  const [
    mainnetMembership,
    hoodiMembership,
    mainnetBlock,
    hoodiBlock,
  ] =
    await Promise.all([
      fetchMembers(mainnetProvider, NETWORKS.mainnet.consensus),
      fetchMembers(hoodiProvider, NETWORKS.hoodi.consensus),
      mainnetProvider.getBlockNumber(),
      hoodiProvider.getBlockNumber(),
    ]);

  const [mainnetHolders, hoodiHolders] = await Promise.all([
    fetchHolders(mainnetProvider, "mainnet", mainnetMembership.members),
    fetchHolders(hoodiProvider, "hoodi", hoodiMembership.members),
  ]);

  const makeSnapshot = (mainnetMessages: BusMessage[], hoodiMessages: BusMessage[], warnings: string[], telemetryLoading: boolean): Snapshot => ({
    mainnet:{members:mainnetMembership.members,holders:mainnetHolders,frames:mainnetMembership.frames,blockNumber:mainnetBlock,messages:mainnetMessages,chainConfig:mainnetMembership.chainConfig,rpcUrl:mainnet.url,warnings,telemetryLoading,fullHistoryLoaded:mode==="telemetry"&&!telemetryLoading},
    hoodi:{members:hoodiMembership.members,holders:hoodiHolders,frames:hoodiMembership.frames,blockNumber:hoodiBlock,messages:hoodiMessages,chainConfig:hoodiMembership.chainConfig,rpcUrl:hoodi.url,warnings,telemetryLoading,fullHistoryLoaded:mode==="telemetry"&&!telemetryLoading},
  });
  const initial=makeSnapshot([],[],[],true);
  progress(structuredClone(initial));
  const telemetry=await fetchDataBus(hoodiProvider,mode,initial), messages=telemetry.messages;

  // Attribute each message to the member (for the participation views) and
  // to the holder (for the Holders view) that own the sending key.
  const attachMembersToTelemetry = (
    chainId: number,
    members: Member[],
    holders: Holder[],
  ) => {
    const memberByDelegate = new Map(
      members.map((member) => [
        member.delegateAddress ?? member.address,
        member.address,
      ]),
    );
    const holderBySender = new Map(
      holders.flatMap((holder) =>
        holder.senders.map((sender) => [sender, holder.contract] as const),
      ),
    );
    return messages.flatMap((message) => {
      if (message.chainId !== chainId) return [];
      const memberAddress = memberByDelegate.get(message.sender);
      const holderAddress = holderBySender.get(message.sender);
      return memberAddress || holderAddress
        ? [{ ...message, memberAddress, holderAddress }]
        : [];
    });
  };
  const mainnetMessages = attachMembersToTelemetry(
    MAINNET_CHAIN_ID,
    mainnetMembership.members,
    mainnetHolders,
  );
  const hoodiMessages = attachMembersToTelemetry(
    HOODI_CHAIN_ID,
    hoodiMembership.members,
    hoodiHolders,
  );

  // The telemetry key lives on the DataBus network (Hoodi) for both oracle
  // networks; its balance is read there.
  const attachTelemetryBalances = async (
    members: Member[],
    attached: BusMessage[],
  ) => {
    const senderByMember = new Map<string, string>();
    for (const message of attached) {
      if (message.memberAddress && !senderByMember.has(message.memberAddress)) {
        senderByMember.set(message.memberAddress, message.sender);
      }
    }
    await Promise.all(
      members.map(async (member) => {
        const sender = senderByMember.get(member.address);
        if (!sender) return;
        member.telemetryAddress = sender;
        member.telemetryBalanceEth = await readBalance(hoodiProvider, sender).catch(
          () => undefined,
        );
      }),
    );
  };
  await Promise.all([
    attachTelemetryBalances(mainnetMembership.members, mainnetMessages),
    attachTelemetryBalances(hoodiMembership.members, hoodiMessages),
  ]);

  return makeSnapshot(mode==="overview"?compactOracleMessages(mainnetMessages):mainnetMessages,mode==="overview"?compactOracleMessages(hoodiMessages):hoodiMessages,telemetry.warnings,false);
  } finally {
    mainnetProvider.destroy();
    hoodiProvider.destroy();
  }
}

