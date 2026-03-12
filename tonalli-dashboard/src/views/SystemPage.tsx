import { useEffect, useState } from "react";
import { activeIdentity } from "../config/activeIdentity";
import { treasuryConfig } from "../config/treasury";
import {
  checkCaeStatus,
  fetchActiveRFC,
  fetchCaeStatus,
  getCaeStatusEndpoint,
  type ActiveRFC,
  type CaeLiveStatus,
  type CaeStatus
} from "../services/caeApi";
import {
  getAddressBalance,
  getChronikAddressEndpoint,
  checkChronikStatus,
  getChronikStatusEndpoint,
  type ChronikAddressBalance,
  type ChronikStatus
} from "../services/chronikApi";
import { SectionCard } from "../ui/SectionCard";

const LIVE_STATUS_REFRESH_MS = 15000;

const eventBusStatus = {
  detail: "LISTENING",
  summary: "Canal interno operativo sin backend adicional.",
  channel: "in-memory"
} as const;

type TreasurySignalTone = "guarded" | "online" | "offline";

function formatSats(sats: number) {
  return sats.toLocaleString("es-MX");
}

function getTreasurySignal(balance: ChronikAddressBalance) {
  const lowThresholdSats = treasuryConfig.lowThresholdSats;

  if (balance.sats === null) {
    return {
      level: "unavailable",
      tone: "offline" as TreasurySignalTone,
      label: "SIN LECTURA",
      summary: "La señal de tesorería baja queda en espera hasta recuperar el balance real.",
      thresholdLabel: `${formatSats(lowThresholdSats)} sats`
    };
  }

  if (balance.sats <= lowThresholdSats) {
    return {
      level: "low",
      tone: "guarded" as TreasurySignalTone,
      label: "TREASURY LOW",
      summary: `Tesorería por debajo del umbral operativo de ${formatSats(lowThresholdSats)} sats.`,
      thresholdLabel: `${formatSats(lowThresholdSats)} sats`
    };
  }

  return {
    level: "healthy",
    tone: "online" as TreasurySignalTone,
    label: "ESTABLE",
    summary: `Tesorería por encima del umbral operativo de ${formatSats(lowThresholdSats)} sats.`,
    thresholdLabel: `${formatSats(lowThresholdSats)} sats`
  };
}

export function SystemPage() {
  const [activeRFC, setActiveRFC] = useState<ActiveRFC>({
    status: "NONE",
    filename: null,
    timestamp: null,
    ageMs: null
  });
  const [caeLiveStatus, setCaeLiveStatus] = useState<CaeLiveStatus>({
    online: false,
    detail: "RESPONDING"
  });
  const [caeStatus, setCaeStatus] = useState<CaeStatus | null>(null);
  const [chronikStatus, setChronikStatus] = useState<ChronikStatus>({
    online: false,
    detail: "OFFLINE",
    summary: "Chronik no responde por el proxy local.",
    tipHash: null,
    tipHeight: null,
    network: null,
    version: null
  });
  const [treasuryBalance, setTreasuryBalance] = useState<ChronikAddressBalance>({
    address: activeIdentity.treasuryAddress ?? "",
    sats: null,
    xec: null,
    utxoCount: null,
    summary: activeIdentity.treasuryAddress
      ? "Esperando lectura real de tesoreria desde Chronik."
      : "No hay direccion activa configurada para consultar tesoreria.",
    endpoint: getChronikAddressEndpoint(activeIdentity.treasuryAddress ?? "address")
  });

  useEffect(() => {
    let active = true;
    let controller = new AbortController();

    const loadStatus = async () => {
      controller.abort();
      controller = new AbortController();

      const [caeResult, chronikResult, treasuryResult, activeRfcResult] = await Promise.allSettled([
        fetchCaeStatus(controller.signal),
        checkChronikStatus(controller.signal),
        getAddressBalance(activeIdentity.treasuryAddress ?? "", controller.signal),
        fetchActiveRFC(controller.signal)
      ]);

      if (!active || controller.signal.aborted) {
        return;
      }

      if (caeResult.status === "fulfilled") {
        setCaeStatus(caeResult.value);
        setCaeLiveStatus({
          online: true,
          detail: "ONLINE"
        });
      } else {
        setCaeStatus(null);
        setCaeLiveStatus(await checkCaeStatus(controller.signal));
      }

      if (chronikResult.status === "fulfilled") {
        setChronikStatus(chronikResult.value);
      } else {
        setChronikStatus({
          online: false,
          detail: "OFFLINE",
          summary: "Chronik no responde por el proxy local.",
          tipHash: null,
          tipHeight: null,
          network: null,
          version: null
        });
      }

      if (treasuryResult.status === "fulfilled") {
        setTreasuryBalance(treasuryResult.value);
      } else {
        setTreasuryBalance({
          address: activeIdentity.treasuryAddress ?? "",
          sats: null,
          xec: null,
          utxoCount: null,
          summary: "Chronik no expuso balance util para la direccion activa por el proxy local.",
          endpoint: getChronikAddressEndpoint(activeIdentity.treasuryAddress ?? "address")
        });
      }

      if (activeRfcResult.status === "fulfilled") {
        setActiveRFC(activeRfcResult.value);
      } else {
        setActiveRFC({
          status: "NONE",
          filename: null,
          timestamp: null,
          ageMs: null
        });
      }
    };

    void loadStatus();
    const intervalId = window.setInterval(() => {
      void loadStatus();
    }, LIVE_STATUS_REFRESH_MS);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  const treasurySignal = getTreasurySignal(treasuryBalance);

  const infrastructureSignals = [
    {
      title: "Tribunal CAE",
      value: caeLiveStatus.detail,
      detail: caeStatus?.summary ?? "Pulso constitucional via proxy local.",
      tone: caeLiveStatus.detail.toLowerCase()
    },
    {
      title: "Nodo Chronik",
      value: chronikStatus.detail,
      detail: chronikStatus.summary,
      tone: chronikStatus.detail.toLowerCase()
    },
    {
      title: "Identidad Activa",
      value: activeIdentity.name,
      detail: activeIdentity.role
    },
    {
      title: "Event Bus",
      value: eventBusStatus.detail,
      detail: eventBusStatus.summary,
      tone: eventBusStatus.detail.toLowerCase()
    },
    {
      title: "Tesoreria",
      value: treasurySignal.label,
      detail: treasurySignal.summary,
      tone: treasurySignal.tone
    }
  ];

  return (
    <div className="page">
      <SectionCard
        title="Centro de Comando"
        subtitle="Infraestructura soberana de la Civilizacion Tonalli"
      >
        <section className="status-grid">
          {infrastructureSignals.map((signal) => (
            <article key={signal.title} className="status-card">
              <span className="panel-label">{signal.title}</span>
              {signal.tone ? (
                <div className={`tribunal-live-badge tribunal-live-${signal.tone}`}>
                  <span className="tribunal-live-dot" />
                  {signal.value}
                </div>
              ) : (
                <strong>{signal.value}</strong>
              )}
              <p>{signal.detail}</p>
            </article>
          ))}
        </section>
      </SectionCard>

      <section className="dashboard-grid">
        <SectionCard
          title="Supervision de servicios"
          subtitle="Checks reales y contexto operativo en una sola vista"
        >
          <div className="table-list">
            <div className="table-row">
              <div>
                <strong>Tribunal CAE</strong>
                <p>Motor constitucional enlazado por proxy de Vite</p>
              </div>
              <div className={`tribunal-live-badge tribunal-live-${caeLiveStatus.detail.toLowerCase()}`}>
                <span className="tribunal-live-dot" />
                {caeLiveStatus.detail}
              </div>
              <span>{getCaeStatusEndpoint()}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Nodo Chronik</strong>
                <p>Primer check real del dashboard usando blockchain info</p>
              </div>
              <div className={`tribunal-live-badge tribunal-live-${chronikStatus.detail.toLowerCase()}`}>
                <span className="tribunal-live-dot" />
                {chronikStatus.detail}
              </div>
              <span>{getChronikStatusEndpoint()}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Identidad Activa</strong>
                <p>Contexto local del operador soberano</p>
              </div>
              <div className="badge badge-neutral">{activeIdentity.role}</div>
              <span>{activeIdentity.origin}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Event Bus</strong>
                <p>Canal actual preservado sin agregar backend</p>
              </div>
              <div className="tribunal-live-badge tribunal-live-listening">
                <span className="tribunal-live-dot" />
                {eventBusStatus.detail}
              </div>
              <span>{eventBusStatus.channel}</span>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Telemetria"
          subtitle="Detalle util para diagnostico sin alterar el layout global"
        >
          <div className={`treasury-alert treasury-alert-${treasurySignal.level}`}>
            <div>
              <span className="panel-label">Reserva operativa</span>
              <strong>{treasurySignal.label}</strong>
              <p>{treasurySignal.summary}</p>
            </div>
            <div className={`badge badge-${treasurySignal.tone}`}>
              Umbral: {treasurySignal.thresholdLabel}
            </div>
          </div>

          <div className="table-list">
            <div className="table-row">
              <div>
                <strong>Funding Campaign</strong>
                <p>Estado del ultimo RFC emitido por la memoria operativa de Teyolia</p>
              </div>
              <div className={`badge badge-${activeRFC.status === "ACTIVE" ? "guarded" : "neutral"}`}>
                {activeRFC.status === "ACTIVE" ? "ACTIVE" : "STANDBY"}
              </div>
              <span>
                {activeRFC.status === "ACTIVE"
                  ? "Campana de fondeo con RFC vigente en las ultimas 24 horas."
                  : "Sin RFC reciente dentro de la ventana operativa."}
              </span>
            </div>

            <div className="table-row">
              <div>
                <strong>Latest RFC</strong>
                <p>Ultimo borrador detectado en el repositorio institucional</p>
              </div>
              <div className={`badge badge-${activeRFC.status === "ACTIVE" ? "guarded" : "neutral"}`}>
                {activeRFC.filename ?? "sin dato"}
              </div>
              <span>{activeRFC.filename ?? "No existe un RFC activo para exponer en esta vista."}</span>
            </div>
          </div>

          <div className="table-list">
            <div className="table-row">
              <div>
                <strong>Resumen CAE</strong>
                <p>Ultima lectura consolidada del tribunal</p>
              </div>
              <div className="badge badge-neutral">
                {caeStatus?.decision ?? caeLiveStatus.detail}
              </div>
              <span>{caeStatus?.summary ?? "Esperando respuesta valida del CAE"}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Altura Chronik</strong>
                <p>Dato real si Chronik responde por el proxy local</p>
              </div>
              <div className="badge badge-neutral">
                {chronikStatus.tipHeight ?? "sin dato"}
              </div>
              <span>{chronikStatus.tipHash ?? chronikStatus.summary}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Red Chronik</strong>
                <p>Metadata minima expuesta por blockchain info</p>
              </div>
              <div className="badge badge-neutral">
                {chronikStatus.network ?? "sin dato"}
              </div>
              <span>{chronikStatus.version ?? "version no expuesta"}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Tesoreria real</strong>
                <p>Balance base de la direccion activa via Chronik</p>
              </div>
              <div className={`badge badge-${treasurySignal.tone}`}>
                {treasuryBalance.xec !== null ? `${treasuryBalance.xec.toLocaleString("es-MX")} XEC` : "sin dato"}
              </div>
              <span>{treasuryBalance.summary}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Umbral treasury low</strong>
                <p>Senal local configurable para futuras reacciones del agente</p>
              </div>
              <div className={`badge badge-${treasurySignal.tone}`}>
                {treasurySignal.thresholdLabel}
              </div>
              <span>{treasurySignal.summary}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>UTXOs basicos</strong>
                <p>Conteo simple de salidas no tokenizadas</p>
              </div>
              <div className="badge badge-neutral">
                {treasuryBalance.utxoCount ?? "sin dato"}
              </div>
              <span>{treasuryBalance.address || "direccion no configurada"}</span>
            </div>

            <div className="table-row">
              <div>
                <strong>Identidad vigente</strong>
                <p>Actor actual que opera el dashboard</p>
              </div>
              <div className="badge badge-neutral">{activeIdentity.name}</div>
              <span>{activeIdentity.treasuryAddress ?? activeIdentity.origin}</span>
            </div>
          </div>
        </SectionCard>
      </section>
    </div>
  );
}
