import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

import type { ToolMessage } from '../types';
import { formatToolDuration, peekToolStart } from '../utils/toolTiming';

/**
 * Duration chip text shared by tool cards: the recorded durationMs once the
 * tool finished, or a live 1s tick from the client-side start map while
 * running (only when live and status say so). Empty string = render nothing,
 * so the chip never flashes a misleading 0s.
 */
export function useToolDuration(
  tool: { value: ToolMessage },
  status: { value: string },
  live: () => boolean,
): Ref<string> {
  const durationText = ref('');
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop() {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  watch(
    () => [tool.value.durationMs, status.value] as const,
    () => {
      stop();
      const ms = tool.value.durationMs;
      if (ms !== undefined) {
        durationText.value = formatToolDuration(ms);
        return;
      }
      durationText.value = '';
      if (status.value !== 'running' || !live()) return;
      const started = peekToolStart(tool.value.toolCallId);
      if (started === undefined) return;
      durationText.value = formatToolDuration(Date.now() - started);
      timer = setInterval(() => {
        durationText.value = formatToolDuration(Date.now() - started);
      }, 1000);
    },
    { immediate: true },
  );

  onBeforeUnmount(stop);
  return durationText;
}
