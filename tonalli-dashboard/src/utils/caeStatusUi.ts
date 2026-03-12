import type { CaeStatusDetail } from "../services/caeApi";

export function getCaeStatusCopy(detail: CaeStatusDetail) {
  switch (detail) {
    case "ONLINE":
      return {
        detail,
        label: "Tribunal operativo",
        operatorState: "Tribunal reachable",
        verdict: "Tribunal listo para dictámenes"
      };
    case "RESPONDING":
      return {
        detail,
        label: "Tribunal responde, health parcial",
        operatorState: "Tribunal partial",
        verdict: "Tribunal disponible con health parcial"
      };
    case "OFFLINE":
    default:
      return {
        detail: "OFFLINE" as const,
        label: "Tribunal fuera de línea",
        operatorState: "Tribunal unreachable",
        verdict: "Sin conexion con el Tribunal"
      };
  }
}
