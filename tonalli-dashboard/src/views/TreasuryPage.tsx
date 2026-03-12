import { treasuryMovements } from "../data/mockData";
import { SectionCard } from "../ui/SectionCard";

export function TreasuryPage() {
  return (
    <div className="page">
      <SectionCard
        title="Camara de tesoreria"
        subtitle="Actividad simulada del fondo Tonalli"
      >
        <div className="table-list">
          {treasuryMovements.map((movement) => (
            <div key={movement.id} className="table-row">
              <div>
                <strong>{movement.id}</strong>
                <p>{movement.memo}</p>
              </div>
              <div className="badge badge-neutral">{movement.status}</div>
              <span>{movement.amount}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
