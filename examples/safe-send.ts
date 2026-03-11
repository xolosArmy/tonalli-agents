import { safeSendXEC } from "../src/wallet/safeSendXEC";
import { onEvent, Topics } from "../src/events/bus";
import { env } from "../src/config/env";

// Escuchamos los eventos como si fuéramos el Orchestrator
onEvent(Topics.TX_SIGNED, (data) => console.log("🟢 EVENTO RECIBIDO: Transacción Firmada", data));
onEvent(Topics.POLICY_REJECTED, (data) => console.log("🔴 EVENTO RECIBIDO: Violación de Política", data));

async function main() {
  console.log(`\n--- Prueba 1: Pago Constitucional (Límite: ${env.AGENT_DAILY_LIMIT_SATS} sats) ---`);
  try {
    const result = await safeSendXEC({
      toAddress: "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
      amountSats: 10000, // Dentro del límite
      reason: "Pago de servidor VPS",
      memo: "Infraestructura xNS"
    });
    console.log("✅ RESULTADO:", result.preflight.decision);
  } catch (error: any) {
    console.error(error.message);
  }

  console.log(`\n--- Prueba 2: Intento de Gasto Malicioso ---`);
  try {
    // Intentamos gastar 200,000,000 (Supera el límite de 100,000,000 del .env)
    const badResult = await safeSendXEC({
      toAddress: "ecash:q_hacker_wallet",
      amountSats: 200000000, 
      reason: "Drenar tesorería",
    });
  } catch (error: any) {
    console.error(error.message);
  }
}

main();
