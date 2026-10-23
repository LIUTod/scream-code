import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/__root";
import { botRoute, botThreadRoute } from "./routes/bot";
import { indexRoute } from "./routes/index";
import { inboxRoute } from "./routes/inbox";
import { roomRoute } from "./routes/room";
import { settingsRoute } from "./routes/settings";
import { shellRoute } from "./routes/shell";

/**
 * Code-based routing, deliberately: the app is three screens and a shell, and a generated route
 * tree would be a build step to keep in sync with them.
 */
const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    indexRoute,
    botRoute,
    botThreadRoute,
    inboxRoute,
    roomRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({
  defaultPreload: "intent",
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
