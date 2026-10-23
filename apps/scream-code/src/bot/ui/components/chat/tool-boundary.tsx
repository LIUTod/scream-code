import { Component, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function ToolRenderBoundary({ name, children }: { name: string; children: ReactNode }) {
  const { t } = useI18n();
  return <RenderBoundary fallback={<p className="my-2 text-xs text-destructive" role="alert">{t("transcript.toolRenderFailed", { name })}</p>}>{children}</RenderBoundary>;
}
