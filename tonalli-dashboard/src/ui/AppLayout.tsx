import { NavLink, Outlet } from "react-router-dom";

const navigation = [
  { to: "/", label: "Nucleo", end: true },
  { to: "/agents", label: "Agentes" },
  { to: "/treasury", label: "Tesoreria" },
  { to: "/tribunal", label: "Tribunal" },
  { to: "/commands", label: "Comandos" }
];

export function AppLayout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Civilizacion Tonalli</p>
          <h1>Consola soberana</h1>
          <p className="sidebar-copy">
            Monitoreo ritual de agentes, tesoreria y ordenes del sistema.
          </p>
        </div>

        <nav className="nav">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "nav-link nav-link-active" : "nav-link"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-panel">
          <span className="panel-label">Estado de enlace</span>
          <strong>Ritmo estable</strong>
          <p>Latencia promedio de 42 ms con guardias activas.</p>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Modo nocturno</p>
            <h2>Tonalli Dashboard</h2>
          </div>
          <div className="status-pill">
            <span className="status-dot" />
            Operacion soberana
          </div>
        </header>

        <Outlet />
      </main>
    </div>
  );
}
