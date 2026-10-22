import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { concat, getBytes, sha256 } from "ethers";
const zero = new Uint8Array(32);
const hash = (a: Uint8Array, b: Uint8Array) => getBytes(sha256(concat([a,b])));
// SSZ DepositMessage + fork-agnostic DOMAIN_DEPOSIT. The POP ciphersuite
// differs from noble's default NUL suite, so hash to G2 with the explicit DST.
export function validPendingDeposit(d: { pubkey: string; withdrawal_credentials: string; amount: string; signature: string }, genesisFork: string) {
  try {
    const pubkey=getBytes(d.pubkey), signature=getBytes(d.signature), wc=getBytes(d.withdrawal_credentials), fork=getBytes(genesisFork);
    if (pubkey.length!==48 || signature.length!==96 || wc.length!==32 || fork.length!==4) return false;
    const amount=new Uint8Array(32); new DataView(amount.buffer).setBigUint64(0,BigInt(d.amount),true);
    const pkRoot=hash(pubkey.slice(0,32),concatBytes(pubkey.slice(32),new Uint8Array(16)));
    const message=hash(hash(pkRoot,wc),hash(amount,zero));
    const forkChunk=concatBytes(fork,new Uint8Array(28)), forkRoot=hash(forkChunk,zero);
    const domain=concatBytes(new Uint8Array([3,0,0,0]),forkRoot.slice(0,28));
    const signingRoot=hash(message,domain);
    return bls.verify(signature,bls.G2.ProjectivePoint.fromAffine(bls.G2.hashToCurve(signingRoot,{DST:"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_"}).toAffine()),pubkey);
  } catch {return false;}
}
function concatBytes(a: Uint8Array,b: Uint8Array) {const out=new Uint8Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;}
