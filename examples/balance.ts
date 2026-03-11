import { getBalance } from "../src/chronik/balance";
import { env } from "../src/config/env";

async function main() {
  const balance = await getBalance(env.AGENT_WALLET);
  console.log(balance);
}

main();
