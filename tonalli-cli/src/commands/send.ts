import { Command } from "commander";
import { safeSendXEC } from "@xolosarmy/tonalli-agent-sdk";

export const sendCmd = new Command("send")
  .description("Envía XEC sometiéndose primero al Tribunal CAE (MRCL)")
  .requiredOption("-t, --to <address>", "Dirección destino")
  .requiredOption("-a, --amount <sats>", "Cantidad en sats", parseInt)
  .requiredOption("-r, --reason <text>", "Justificación constitucional de la transacción")
  .option("-m, --memo <text>", "Memo opcional")
  .action(async (options) => {
    console.log(`\n⚖️  Sometiendo intención de pago al Tribunal CAE...`);
    console.log(`   Destino: ${options.to}`);
    console.log(`   Monto:   ${options.amount} sats`);
    console.log(`   Motivo:  "${options.reason}"\n`);

    try {
      const result = await safeSendXEC({
        toAddress: options.to,
        amountSats: options.amount,
        reason: options.reason,
        memo: options.memo
      });

      console.log("⏸️ [NO IMPLEMENTADO] La intención no fue firmada ni transmitida.");
      console.log(`   Estado:   ${result.status}`);
      console.log(`   Trace ID: ${result.policyDecision.policyTraceId ?? "no disponible"}\n`);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });
