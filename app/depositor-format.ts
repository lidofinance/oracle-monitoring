// Format decimal ETH without float conversion, rounding or insignificant zeros.
export function displayEth(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const decimals = fraction.replace(/0+$/, "");
  return `${BigInt(whole).toLocaleString("en-US")}${decimals ? `.${decimals}` : ""}`;
}
