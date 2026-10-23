import { IconKeyboard, IconLayoutSidebar, IconMoon, IconSun } from "@tabler/icons-react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { LangToggle, useI18n } from "@/lib/i18n";
import { forgetActiveBot } from "@/lib/session";
import { readTheme, type Theme, writeTheme } from "@/lib/theme";
import { shellRoute } from "./shell";
import { useShell } from "@/components/layout/shell-context";
import { useBotConnectionState } from "@/lib/api/events";

export const settingsRoute = createRoute({
  component: SettingsPage,
  getParentRoute: () => shellRoute,
  path: "/settings",
});

const THEMES: { id: Theme; key: "settings.light" | "settings.dark" | "settings.system" }[] = [
  { id: "light", key: "settings.light" },
  { id: "dark", key: "settings.dark" },
  { id: "system", key: "settings.system" },
];

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const navigate = useNavigate();
  const { openRail } = useShell();
  const connection = useBotConnectionState();
  const { t } = useI18n();

  return (
    <PageShell
      action={<Button aria-label={t("cockpit.openNav")} className="lg:hidden" onClick={openRail} size="icon-sm" variant="ghost"><IconLayoutSidebar className="size-4" /></Button>}
      description={t("settings.description")}
      title={t("settings.title")}
    >
      <PageSection title={t("settings.appearance")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.language")}</ItemTitle>
              <ItemDescription>{t("settings.languageDescription")}</ItemDescription>
            </ItemContent>
            <div className="p-2">
              <LangToggle />
            </div>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.theme")}</ItemTitle>
              <ItemDescription>{t("settings.themeDescription")}</ItemDescription>
            </ItemContent>
            <div className="flex items-center gap-1 p-2">
              {THEMES.map((entry) => (
                <Button
                  key={entry.id}
                  onClick={() => {
                    setTheme(entry.id);
                    writeTheme(entry.id);
                  }}
                  size="sm"
                  variant={theme === entry.id ? "secondary" : "ghost"}
                >
                  {t(entry.key)}
                </Button>
              ))}
            </div>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.opens")}</ItemTitle>
              <ItemDescription>{t("settings.opensDescription")}</ItemDescription>
            </ItemContent>
            <div className="p-2">
              <Button
                onClick={() => {
                  forgetActiveBot();
                  void navigate({ to: "/" });
                }}
                size="sm"
                variant="outline"
              >
                {t("settings.forget")}
              </Button>
            </div>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection title={t("settings.keyboard")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.command")}</ItemTitle>
              <ItemDescription>{t("settings.commandDescription")}</ItemDescription>
            </ItemContent>
            <div className="flex items-center gap-1.5 px-3 text-muted-foreground">
              <IconKeyboard className="size-4" />
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                ⌘K
              </kbd>
            </div>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.composer")}</ItemTitle>
              <ItemDescription>{t("settings.composerDescription")}</ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection title={t("settings.transport")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.dataSource")}</ItemTitle>
              <ItemDescription>{t("settings.dataSourceDescription")}</ItemDescription>
            </ItemContent>
            <span className="mx-3 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {t(`connection.${connection.status}`)}
            </span>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.singleUser")}</ItemTitle>
              <ItemDescription>{t("settings.singleUserDescription")}</ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>

      <p className="mt-10 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {theme === "dark" ? (
          <IconMoon className="size-3.5" />
        ) : (
          <IconSun className="size-3.5" />
        )}
        {t("settings.footer")}
      </p>
    </PageShell>
  );
}
