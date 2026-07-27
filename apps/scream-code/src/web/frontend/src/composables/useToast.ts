import { ref } from 'vue';

export interface ToastItem {
  id: string;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
}

const toasts = ref<ToastItem[]>([]);

let counter = 0;

function showToast(
  message: string,
  type: ToastItem['type'] = 'info',
  duration = 3500,
): void {
  const id = `toast_${++counter}`;
  toasts.value = [...toasts.value, { id, type, message }];
  if (duration > 0) {
    window.setTimeout(() => removeToast(id), duration);
  }
}

function removeToast(id: string): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function useToast() {
  return { toasts, showToast, removeToast };
}
