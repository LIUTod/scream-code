import { createRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { rootRoute } from "./__root";

export const shellRoute = createRoute({
  component: ShellLayout,
  getParentRoute: () => rootRoute,
  id: "_shell",
});

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
