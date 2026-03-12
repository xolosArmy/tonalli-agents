export type Kpi = {
  label: string;
  value: string;
  delta: string;
};

export type AgentStatus = "online" | "syncing" | "guarded";

export type Agent = {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  lastPulse: string;
};

export type TreasuryMovement = {
  id: string;
  type: string;
  amount: string;
  status: string;
  memo: string;
};

export type CommandLog = {
  id: string;
  command: string;
  origin: string;
  status: string;
  timestamp: string;
};

export const kpis: Kpi[] = [
  { label: "Agentes enlazados", value: "12", delta: "+2 hoy" },
  { label: "Tesoreria activa", value: "1.28M MXN", delta: "+4.6%" },
  { label: "Politicas vigentes", value: "24", delta: "0 alertas" },
  { label: "Comandos soberanos", value: "184", delta: "93% aprobados" }
];

export const agents: Agent[] = [
  {
    id: "AG-01",
    name: "Xolo Sentinel",
    role: "Vigilancia de runtime",
    status: "online",
    lastPulse: "hace 14 s"
  },
  {
    id: "AG-02",
    name: "Treasury Keeper",
    role: "Custodia de reservas",
    status: "guarded",
    lastPulse: "hace 43 s"
  },
  {
    id: "AG-03",
    name: "Route Scribe",
    role: "Orquestacion de comandos",
    status: "syncing",
    lastPulse: "hace 2 min"
  }
];

export const treasuryMovements: TreasuryMovement[] = [
  {
    id: "TX-9901",
    type: "Ingreso",
    amount: "+240,000 MXN",
    status: "Confirmado",
    memo: "Aporte al fondo comun"
  },
  {
    id: "TX-9902",
    type: "Reserva",
    amount: "-35,000 MXN",
    status: "Custodia",
    memo: "Blindaje de operaciones"
  },
  {
    id: "TX-9903",
    type: "Flujo",
    amount: "+12,400 MXN",
    status: "Pendiente",
    memo: "Rebalanceo semanal"
  }
];

export const commandLogs: CommandLog[] = [
  {
    id: "CMD-770",
    command: "tonalli treasury status",
    origin: "CLI central",
    status: "Ejecutado",
    timestamp: "09:12"
  },
  {
    id: "CMD-771",
    command: "tonalli agents scan --deep",
    origin: "Panel soberano",
    status: "En cola",
    timestamp: "09:18"
  },
  {
    id: "CMD-772",
    command: "tonalli policy verify",
    origin: "Guardia automatica",
    status: "Ejecutado",
    timestamp: "09:21"
  }
];
