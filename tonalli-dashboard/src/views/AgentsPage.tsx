import { useEffect, useState } from "react";
import { activeIdentity } from "../config/activeIdentity";
import { agents } from "../data/mockData";
import { checkCaeStatus, type CaeStatusDetail } from "../services/caeApi";
import { SectionCard } from "../ui/SectionCard";
import { getCaeStatusCopy } from "../utils/caeStatusUi";

export function AgentsPage() {
  const [caeDetail, setCaeDetail] = useState<CaeStatusDetail>("OFFLINE");

  useEffect(() => {
    const controller = new AbortController();

    checkCaeStatus(controller.signal)
      .then((status) => {
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

  return (
    <div className="page">
      <SectionCard
        title="Active Operator"
        subtitle="Identidad activa derivada del contexto local"
      >
        <div className="table-list">
          <div className="table-row">
            <div>
              <strong>{activeIdentity.name}</strong>
              <p>{activeIdentity.role}</p>
            </div>
            <div className={`tribunal-live-badge tribunal-live-${caeStatus.detail.toLowerCase()}`}>
              <span className="tribunal-live-dot" />
              {caeStatus.operatorState}
            </div>
            <span>{activeIdentity.origin}</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Censo de agentes"
        subtitle="Registro mock de operadores soberanos"
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
    </div>
  );
}
