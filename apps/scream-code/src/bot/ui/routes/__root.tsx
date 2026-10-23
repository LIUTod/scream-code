import { createRootRoute, Outlet } from "@tanstack/react-router";

function NotFound() {
  return (
    <div className="flex h-svh items-center justify-center bg-background p-8">
      <div className="text-center">
        <p className="text-muted-foreground text-sm">That page does not exist.</p>
      </div>
    </div>
  );
}

function RootLayout() {
  return <Outlet />;
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});
