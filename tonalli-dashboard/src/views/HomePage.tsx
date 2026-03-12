import { useEffect, useState } from "react";
import { activeIdentity } from "../config/activeIdentity";
import { agents, commandLogs, treasuryMovements } from "../data/mockData";
import { checkCaeStatus, type CaeLiveStatus, type CaeStatusDetail } from "../services/caeApi";
import { SectionCard } from "../ui/SectionCard";
import { getCaeStatusCopy } from "../utils/caeStatusUi";

export function HomePage() {
  const [caeDetail, setCaeDetail] = useState<CaeStatusDetail>("OFFLINE");

  useEffect(() => {
    const controller = new AbortController();

    checkCaeStatus(controller.signal)
      .then((status: CaeLiveStatus) => {
        setCaeDetail(status.detail);
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }

        setCaeDetail("OFFLINE");
      });

    return () => controller.abort();
  }, []);

  const caeStatus = getCaeStatusCopy(caeDetail);
  const civilizationSignals = [
    {
      title: "Tribunal CAE",
      value: caeStatus.detail,
      detail: caeStatus.label,
      tone: caeStatus.detail.toLowerCase()
    },
    {
      title: "Chronik Node",
      value: "OFFLINE",
      detail: "Pendiente de integracion real",
      tone: "offline"
    },
    {
      title: "Event Bus",
      value: "LISTENING",
      detail: "Canal mock activo",
      tone: "listening"
    },
    {
      title: "Active Identity",
      value: activeIdentity.name,
      detail: activeIdentity.role
    }
  ];
  const vitals = [
    { label: "Agentes activos", value: "12", delta: "+2 hoy" },
    { label: "Monto custodiado", value: "1.28M MXN", delta: "+4.6%" },
    {
      label: "Ultimo dictamen",
      value: caeStatus.verdict,
      delta: "Sincronizado con Tribunal CAE"
    }
  ];

  return (
    <div className="page">
      <SectionCard
        title="Civilization Status"
        subtitle="Pulso operativo de app.tonalli.cash"
      >
        <section className="status-grid">
          {civilizationSignals.map((signal) => (
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

      <section className="kpi-grid kpi-grid-compact">
        {vitals.map((kpi) => (
          <article key={kpi.label} className="kpi-card">
            <span>{kpi.label}</span>
            <strong>{kpi.value}</strong>
            <p>{kpi.delta}</p>
          </article>
        ))}
      </section>

      <section className="dashboard-grid">
        <SectionCard
          title="Agentes destacados"
          subtitle={`Pulso general del roster · ${caeStatus.label}`}
        >
          <div className="table-list">
            {agents.map((agent) => (
              <div key={agent.id} className="table-row">
                <div>
                  <strong>{agent.name}</strong>
                  <p>{agent.role}</p>
                </div>
                <div className={`badge badge-${agent.status}`}>{agent.status}</div>
                <span>{agent.lastPulse}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="Tesoreria viva"
          subtitle="Ultimos movimientos del fondo"
        >
          <div className="table-list">
            {treasuryMovements.map((movement) => (
              <div key={movement.id} className="table-row">
                <div>
                  <strong>{movement.amount}</strong>
                  <p>{movement.memo}</p>
                </div>
                <div className="badge badge-neutral">{movement.status}</div>
                <span>{movement.type}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </section>

      <SectionCard title="Bitacora de comandos" subtitle="Eventos recientes">
        <div className="table-list">
          {commandLogs.map((log) => (
            <div key={log.id} className="table-row">
              <div>
                <strong>{log.command}</strong>
                <p>{log.origin}</p>
              </div>
              <div className="badge badge-neutral">{log.status}</div>
              <span>{log.timestamp}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
