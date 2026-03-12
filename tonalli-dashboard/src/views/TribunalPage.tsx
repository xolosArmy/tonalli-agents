import { useEffect, useState } from "react";
import { agents, commandLogs } from "../data/mockData";
import {
  checkCaeStatus,
  fetchCaeStatus,
  getCaeStatusEndpoint,
  type CaeLiveStatus,
  type CaeStatus
} from "../services/caeApi";
import { SectionCard } from "../ui/SectionCard";

const LIVE_STATUS_REFRESH_MS = 15000;

export function TribunalPage() {
  const [liveStatus, setLiveStatus] = useState<CaeLiveStatus>({
    online: false,
    detail: "RESPONDING"
  });
  const [caeStatus, setCaeStatus] = useState<CaeStatus | null>(null);

  useEffect(() => {
    let active = true;

    const loadStatus = async () => {
      try {
        const status = await fetchCaeStatus();

        if (!active) {
          return;
        }

        setCaeStatus(status);
        setLiveStatus({
          online: true,
          detail: "ONLINE"
        });
      } catch {
        if (!active) {
          return;
        }

        setCaeStatus(null);
        setLiveStatus(await checkCaeStatus());
      }
    };

    void loadStatus();
    const intervalId = window.setInterval(() => {
      void loadStatus();
    }, LIVE_STATUS_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div className="page">
      <SectionCard
        title="Tribunal Live Status"
        subtitle="Estado real del Constitutional Alignment Engine"
      >
        <div className="tribunal-live-grid">
          <div className="tribunal-live-copy">
            <span className="panel-label">Endpoint</span>
            <strong>{getCaeStatusEndpoint()}</strong>
            <p>
              Pulso real del preflight constitucional para la firma de
              operaciones.
            </p>
          </div>

          <div className={`tribunal-live-badge tribunal-live-${liveStatus.detail.toLowerCase()}`}>
            <span className="tribunal-live-dot" />
            {liveStatus.detail}
          </div>
        </div>

        <div className="table-list tribunal-facts">
          <div className="table-row">
            <div>
              <strong>Decision vigente</strong>
              <p>Respuesta real mas reciente del motor constitucional</p>
            </div>
            <div className="badge badge-neutral">
              {caeStatus?.decision ?? "sin dato"}
            </div>
            <span>{caeStatus?.summary ?? "Esperando respuesta valida del CAE"}</span>
          </div>
        </div>
      </SectionCard>

      <section className="dashboard-grid">
        <SectionCard
          title="Mesa del tribunal"
          subtitle="Contenido mock preservado durante la transicion"
        >
          <div className="table-list">
            {agents.map((agent) => (
              <div key={agent.id} className="table-row">
                <div>
                  <strong>
                    {agent.id} · {agent.name}
                  </strong>
                  <p>{agent.role}</p>
                </div>
                <div className={`badge badge-${agent.status}`}>{agent.status}</div>
                <span>{agent.lastPulse}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="Bitacora del tribunal"
          subtitle="Secuencia mock de revisiones y mandatos"
        >
          <div className="table-list">
            {commandLogs.map((log) => (
              <div key={log.id} className="table-row">
                <div>
                  <strong>{log.id}</strong>
                  <p>{log.command}</p>
                </div>
                <div className="badge badge-neutral">{log.status}</div>
                <span>{log.origin}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </section>
    </div>
  );
}
