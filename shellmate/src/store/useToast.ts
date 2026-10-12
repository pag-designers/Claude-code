import { create } from 'zustand';

export type ToastItem = { id: number; message: string };

type ToastState = {
  toasts: ToastItem[];
  show: (message: string) => void;
  dismiss: (id: number) => void;
};

let nextId = 1;

export const useToast = create<ToastState>()((set) => ({
  toasts: [],
  show: (message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2800);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (message: string) => useToast.getState().show(message);
