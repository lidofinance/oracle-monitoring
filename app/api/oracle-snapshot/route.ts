import {NextRequest,NextResponse} from 'next/server';
import {RPC_OPTIONS} from '../../rpc-selection';
import {createOracleSnapshotCache} from '../../oracle-snapshot-cache';
import {collectOracleSnapshot} from '../../oracle-snapshot-server';
import type {RpcChoice} from '../../oracle-snapshot-data';
const cache=createOracleSnapshotCache();
export async function GET(request:NextRequest){
 const network=request.nextUrl.searchParams.get('network')??'mainnet',mode=request.nextUrl.searchParams.get('mode')??'overview';
 if(!['mainnet','hoodi'].includes(network)||!['overview','telemetry'].includes(mode))return NextResponse.json({error:'Choose a supported Oracle network and mode.'},{status:400});
 const choice:RpcChoice={},ids:string[]=[];
 for(const n of ['mainnet','hoodi'] as const){
  const id=request.headers.get(`x-lido-${n}-rpc`)??(n===network?request.headers.get('x-lido-rpc'):null);
  if(id){const preset=RPC_OPTIONS[n].find(option=>option.id===id);if(!preset)return NextResponse.json({error:'Choose a supported RPC endpoint.'},{status:400});choice[n]=preset.url;}
  ids.push(`${n}:${id??'auto'}`);
 }
 const result=cache.read(`${ids.join('|')}:${mode}`,progress=>collectOracleSnapshot(choice,mode as 'overview'|'telemetry',progress));
 return NextResponse.json(result,{headers:{'Cache-Control':'no-store','Vary':'x-lido-rpc, x-lido-mainnet-rpc, x-lido-hoodi-rpc'}});
}
