import { chronikClient } from "./chronikClient";

export async function getBalance(address: string) {
  const { data } = await chronikClient.get(`/address/${address}/utxos`);

  const sats = data.utxos
    .filter((u: any) => !u.token)
    .reduce((sum: number, u: any) => sum + u.value, 0);

  return {
    address,
    sats,
    xec: sats / 100
  };
}
