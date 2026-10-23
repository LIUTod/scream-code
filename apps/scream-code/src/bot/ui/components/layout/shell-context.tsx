import { createContext, useContext } from "react";

type ShellContextValue = {
  openRail: () => void;
};

const ShellContext = createContext<ShellContextValue>({
  openRail: () => {},
});

export const ShellProvider = ShellContext.Provider;

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}
