import { commandLogs } from "../data/mockData";
import { SectionCard } from "../ui/SectionCard";

export function CommandsPage() {
  return (
    <div className="page">
      <SectionCard
        title="Trazas de comando"
        subtitle="Historial mock para operaciones del panel"
      >
        <div className="table-list">
          {commandLogs.map((log) => (
            <div key={log.id} className="table-row">
              <div>
                <strong>{log.id}</strong>
                <p>{log.command}</p>
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
