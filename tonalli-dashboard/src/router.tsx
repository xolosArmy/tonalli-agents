import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./ui/AppLayout";
import { AgentsPage } from "./views/AgentsPage";
import { CommandsPage } from "./views/CommandsPage";
import { HomePage } from "./views/HomePage";
import { TreasuryPage } from "./views/TreasuryPage";
import { TribunalPage } from "./views/TribunalPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <HomePage />
      },
      {
        path: "agents",
        element: <AgentsPage />
      },
      {
        path: "treasury",
        element: <TreasuryPage />
      },
      {
        path: "tribunal",
        element: <TribunalPage />
      },
      {
        path: "commands",
        element: <CommandsPage />
      }
    ]
  }
]);
