import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Cockpit } from "@/components/chat/cockpit";
import { shellRoute } from "./shell";

export const botRoute = createRoute({
  component: BotPage,
  getParentRoute: () => shellRoute,
  path: "/bots/$botId",
});

export const botThreadRoute = createRoute({
  component: BotThreadPage,
  getParentRoute: () => shellRoute,
  path: "/bots/$botId/threads/$threadId",
});

function BotPage() {
  const { botId } = botRoute.useParams();
  return <BotScreen botId={botId} />;
}

function BotThreadPage() {
  const { botId, threadId } = botThreadRoute.useParams();
  return <BotScreen botId={botId} threadId={threadId} />;
}

function BotScreen({ botId, threadId }: { botId: string; threadId?: string }) {
  // A drawer that covers the transcript is not a default anybody asked for on a phone.
  const [drawerOpen, setDrawerOpen] = useState(
    () => window.matchMedia("(min-width: 1024px)").matches,
  );
  return (
    <Cockpit
      botId={botId}
      drawerOpen={drawerOpen}
      onDrawerChange={setDrawerOpen}
      threadId={threadId}
    />
  );
}
